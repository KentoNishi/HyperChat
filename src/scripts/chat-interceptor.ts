import { fixLeaks } from '../ts/ytc-fix-memleaks';
import { frameIsReplay as isReplay, checkInjected } from '../ts/chat-utils';
import { chatReportUserOptions, ChatUserActions, isLiveTL, replyThreadPanelTag } from '../ts/chat-constants';
import { parseChatResponse } from '../ts/chat-parser';
import sha1 from 'sha-1';

function injectedFunction(): void {
  for (const eventName of ['visibilitychange', 'webkitvisibilitychange', 'blur']) {
    window.addEventListener(eventName, event => {
      event.stopImmediatePropagation();
    }, true);
  }

  const fetchFallback = window.fetch;
  (window as any).fetchFallback = fetchFallback;
  window.fetch = async (...args) => {
    const request = args[0] as Request;
    const url = request.url;
    const result = await (fetchFallback as any)(...args);

    const currentDomain = (location.protocol + '//' + location.host);
    const ytApi = (end: string): string => `${currentDomain}/youtubei/v1/live_chat${end}`;
    const isReceiving = url.startsWith(ytApi('/get_live_chat'));
    const isSending = url.startsWith(ytApi('/send_message'));
    const action = isReceiving ? 'messageReceive' : 'messageSent';
    if (isReceiving || isSending) {
      const response = JSON.stringify(await (result.clone()).json());
      window.dispatchEvent(new CustomEvent(action, { detail: response }));
    }
    return result;
  };
  window.dispatchEvent(new CustomEvent('chatLoaded', {
    detail: JSON.stringify(window.ytcfg)
  }));
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  window.addEventListener('proxyFetchRequest', async (event) => {
    const payload = JSON.parse((event as any).detail as string) as {
      id: string;
      args: [RequestInfo, RequestInit?];
    };
    try {
      const request = await (fetchFallback as any)(...payload.args);
      const response = await request.json();
      window.dispatchEvent(new CustomEvent('proxyFetchResponse', {
        detail: JSON.stringify({
          id: payload.id,
          response
        })
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('proxyFetchResponse', {
        detail: JSON.stringify({
          id: payload.id,
          error: String(error)
        })
      }));
    }
  });
}

const chatLoaded = async (): Promise<void> => {
  const warning = 'HC button detected, not injecting interceptor.';
  if (!isLiveTL && checkInjected(warning)) return;

  // Register interceptor
  const port: Chat.Port = chrome.runtime.connect();
  port.postMessage({ type: 'registerInterceptor', source: 'ytc', isReplay: isReplay() });

  // Send JSON response to clients
  window.addEventListener('messageReceive', (d) => {
    port.postMessage({
      type: 'processMessageChunk',
      json: (d as CustomEvent).detail
    });
  });

  window.addEventListener('messageSent', (d) => {
    port.postMessage({
      type: 'processSentMessage',
      json: (d as CustomEvent).detail
    });
  });

  window.addEventListener('chatLoaded', (d) => {
    const ytcfg = (JSON.parse((d as CustomEvent).detail) as {
      data_: {
        INNERTUBE_API_KEY: string;
        INNERTUBE_CONTEXT: any;
      };
    });
    const fetcher = async (...args: any[]): Promise<any> => {
      return await new Promise((resolve, reject) => {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const encoded = JSON.stringify({ id, args });
        const onFetchResponse = (e: Event): void => {
          const response = JSON.parse((e as CustomEvent).detail) as {
            id: string;
            response?: any;
            error?: string;
          };
          if (response.id !== id) return;
          window.removeEventListener('proxyFetchResponse', onFetchResponse);
          if (response.error != null) {
            reject(new Error(response.error));
            return;
          }
          resolve(response.response);
        };
        window.addEventListener('proxyFetchResponse', onFetchResponse);
        window.dispatchEvent(new CustomEvent('proxyFetchRequest', {
          detail: encoded
        }));
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    port.onMessage.addListener(async (msg) => {
      const getCookie = (name: string): string => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return (parts.pop() ?? '').split(';').shift() ?? '';
        return '';
      };

      const currentDomain = (location.protocol + '//' + location.host);
      const baseContext = ytcfg.data_.INNERTUBE_CONTEXT;
      const buildInnertubeHeaders = () => {
        const time = Math.floor(Date.now() / 1000);
        const sapisid = getCookie('__Secure-3PAPISID') || getCookie('SAPISID');
        const auth = sapisid ? `SAPISIDHASH ${time}_${sha1(`${time} ${sapisid} ${currentDomain}`)}` : null;
        const authuser = (ytcfg as any)?.data_?.SESSION_INDEX;
        const visitorId = (ytcfg as any)?.data_?.VISITOR_DATA ?? baseContext?.client?.visitorData;
        const clientName = (ytcfg as any)?.data_?.INNERTUBE_CLIENT_NAME;
        const clientVersion = (ytcfg as any)?.data_?.INNERTUBE_CLIENT_VERSION;
        return {
          headers: {
            'Content-Type': 'application/json',
            Accept: '*/*',
            ...(authuser != null ? { 'X-Goog-AuthUser': String(authuser) } : {}),
            ...(visitorId != null ? { 'X-Goog-Visitor-Id': String(visitorId) } : {}),
            ...(clientName != null ? { 'X-Youtube-Client-Name': String(clientName) } : {}),
            ...(clientVersion != null ? { 'X-Youtube-Client-Version': String(clientVersion) } : {}),
            'X-Origin': currentDomain,
            ...(auth != null ? { Authorization: auth } : {})
          },
          method: 'POST' as const,
          mode: 'same-origin' as const
        };
      };

      if (msg.type === 'fetchReplyThread') {
        try {
          const panelRes = await fetcher(
            `${currentDomain}/youtubei/v1/get_panel?prettyPrint=false`,
            {
              ...buildInnertubeHeaders(),
              body: JSON.stringify({
                context: baseContext,
                panelId: replyThreadPanelTag,
                params: msg.params
              })
            }
          );
          const items: any[] = panelRes?.content?.engagementPanelSectionListRenderer
            ?.content?.sectionListRenderer?.contents?.[0]
            ?.liveChatItemDisplayListRenderer?.items ?? [];
          // Reuse parseChatResponse so replies come out shaped identically to live chat messages.
          const fakeChunk = JSON.stringify({
            continuationContents: {
              liveChatContinuation: {
                continuations: [{ timedContinuationData: { timeoutMs: 0 } }],
                actions: items.map((item: any) => ({ addChatItemAction: { item } }))
              }
            }
          });
          const chunk = parseChatResponse(fakeChunk, isReplay());
          port.postMessage({
            type: 'replyThreadResponse',
            requestId: msg.requestId,
            success: true,
            replies: (chunk?.messages ?? []) as Ytc.ParsedMessage[]
          });
        } catch (e) {
          port.postMessage({
            type: 'replyThreadResponse',
            requestId: msg.requestId,
            success: false,
            replies: [],
            error: String(e)
          });
        }
        return;
      }

      if (msg.type !== 'executeChatAction') return;
      const message = msg.message;
      const debugAction = msg.action === ChatUserActions.DELETE_MESSAGE;
      let success = true;
      if (message.params == null) {
        success = false;
      }
      try {
        if (message.params == null) {
          throw new Error('Missing context menu params for message');
        }
        const apiKey = ytcfg.data_.INNERTUBE_API_KEY;
        const contextMenuUrl = `${currentDomain}/youtubei/v1/live_chat/get_item_context_menu?params=` +
          `${encodeURIComponent(message.params)}&pbj=1&key=${apiKey}&prettyPrint=false`;
        // Do not override Innertube headers like X-Goog-Visitor-Id here. Those can differ from
        // ytcfg.context.client.visitorData in subtle ways and cause YT to treat the request as logged out.
        // Instead, let the page-side proxy merge the latest headers from real YT requests.
        const heads = buildInnertubeHeaders();
        const contextMenuContext = JSON.parse(JSON.stringify(baseContext));
        if (debugAction) {
          console.debug('[hc] delete: get_item_context_menu', {
            url: contextMenuUrl,
            messageId: message.messageId,
            paramsPrefix: message.params.slice(0, 24)
          });
        }
        const res = await fetcher(contextMenuUrl, {
          ...heads,
          body: JSON.stringify({ context: contextMenuContext })
        });
        if (debugAction) {
          const iconTypes: string[] = [];
          try {
            const json = JSON.stringify(res);
            // Very rough: just to quickly see if the response contains DELETE menu items at all.
            if (json.includes('"iconType":"DELETE"')) iconTypes.push('DELETE');
            if (json.includes('"iconType":"BLOCK"')) iconTypes.push('BLOCK');
            if (json.includes('"getReportFormEndpoint"')) iconTypes.push('REPORT');
          } catch {}
          console.debug('[hc] delete: context menu response', {
            hasResponse: res != null,
            keys: res != null && typeof res === 'object' ? Object.keys(res) : null,
            hints: iconTypes
          });
        }
        type EndpointProp = 'moderateLiveChatEndpoint' | 'getReportFormEndpoint' |
          'liveChatActionEndpoint' | 'manageLiveChatUserEndpoint';
        function getText(text: any): string {
          if (typeof text?.simpleText === 'string') return text.simpleText;
          if (Array.isArray(text?.runs)) {
            return text.runs.map((r: any) => r?.text).filter(Boolean).join('');
          }
          return '';
        }
        function walkObjects(root: any, visitor: (current: any) => void): void {
          const queue = [root];
          const visited = new Set<any>();
          while (queue.length > 0) {
            const current = queue.shift();
            if (current == null || typeof current !== 'object' || visited.has(current)) continue;
            visited.add(current);
            visitor(current);
            for (const value of Object.values(current)) {
              if (value != null && typeof value === 'object') {
                queue.push(value);
              }
            }
          }
        }
        function findServiceEndpoint(root: any, prop: EndpointProp): any | null {
          let found: any | null = null;
          walkObjects(root, (current) => {
            if (found != null) return;
            if (typeof current?.[prop]?.params === 'string') {
              found = current;
            }
          });
          return found;
        }
        function parseServiceEndpoint(serviceEndpoint: any, prop: EndpointProp): { params: string, context: any } {
          if (typeof serviceEndpoint?.[prop]?.params !== 'string') {
            throw new Error(`Missing service endpoint params for ${prop}`);
          }
          const { clickTrackingParams, [prop]: { params } } = serviceEndpoint;
          const clonedContext = JSON.parse(JSON.stringify(baseContext));
          if (clickTrackingParams != null) {
            clonedContext.clickTracking = {
              clickTrackingParams
            };
          }
          return {
            params,
            context: clonedContext
          };
        }
        function findMenuEndpoint(
          root: any,
          iconType: string,
          prop: EndpointProp,
          labelMatches: Array<(label: string) => boolean> = []
        ): any | null {
          const candidates: Array<{ iconType?: string, label: string, endpoint: any }> = [];
          walkObjects(root, (current) => {
            const menu = current?.menuServiceItemRenderer;
            if (menu == null) return;
            const endpoint = menu?.serviceEndpoint;
            if (typeof endpoint?.[prop]?.params === 'string') {
              candidates.push({
                iconType: menu?.icon?.iconType,
                label: getText(menu?.text),
                endpoint
              });
            }
          });
          for (const c of candidates) {
            if (c.iconType === iconType) return c.endpoint;
          }
          for (const c of candidates) {
            const label = c.label.toLowerCase();
            if (labelMatches.some((matcher) => matcher(label))) {
              return c.endpoint;
            }
          }
          return null;
        }
        function findNestedOptionEndpoint(
          root: any,
          iconType: string,
          optionLabel: string | undefined,
          prop: EndpointProp
        ): any | null {
          if (optionLabel == null) {
            throw new Error(`Missing option label for ${iconType}`);
          }
          let found: any | null = null;
          const normalizedOptionLabel = optionLabel.toLowerCase();
          walkObjects(root, (current) => {
            if (found != null) return;
            const menu = current?.menuServiceItemRenderer;
            if (menu?.icon?.iconType !== iconType) return;
            walkObjects(menu, (menuNode) => {
              if (found != null) return;
              const option = menuNode?.optionSelectableItemRenderer;
              const endpoint = option?.submitEndpoint;
              if (typeof endpoint?.[prop]?.params !== 'string') return;
              if (getText(option?.text).toLowerCase() === normalizedOptionLabel) {
                found = endpoint;
              }
            });
          });
          return found;
        }
        async function postEndpoint(
          serviceEndpoint: any,
          prop: EndpointProp,
          apiPath: string
        ): Promise<any> {
          const { params, context } = parseServiceEndpoint(serviceEndpoint, prop);
          const actionResponse = await fetcher(`${currentDomain}/youtubei/v1/${apiPath}?key=${apiKey}&prettyPrint=false`, {
            ...heads,
            body: JSON.stringify({
              params,
              context
            })
          });
          if (actionResponse?.error != null || actionResponse?.success === false) {
            throw new Error(`${apiPath} request failed`);
          }
          return actionResponse;
        }
        if (msg.action === ChatUserActions.BLOCK) {
          const serviceEndpoint = findMenuEndpoint(res, 'BLOCK', 'moderateLiveChatEndpoint', [
            (label) => label.includes('block')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find block endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint', 'live_chat/moderate');
        } else if (msg.action === ChatUserActions.DELETE_MESSAGE) {
          const serviceEndpoint = findMenuEndpoint(res, 'DELETE', 'moderateLiveChatEndpoint', [
            (label) => label.includes('remove') || label.includes('delete') ||
              label.includes('retract') || label.includes('unsend')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find delete endpoint in context menu');
          }
          if (debugAction) {
            const { params } = parseServiceEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint');
            console.debug('[hc] delete: moderate', {
              paramsPrefix: params.slice(0, 24)
            });
          }
          const moderationResponse = await postEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint', 'live_chat/moderate');
          if (debugAction) {
            console.debug('[hc] delete: moderate response', {
              keys: moderationResponse != null && typeof moderationResponse === 'object'
                ? Object.keys(moderationResponse)
                : null,
              hasError: moderationResponse?.error != null,
              success: moderationResponse?.success
            });
          }
        } else if (msg.action === ChatUserActions.PIN_MESSAGE) {
          const serviceEndpoint = findMenuEndpoint(res, 'KEEP', 'liveChatActionEndpoint', [
            (label) => label.includes('pin')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find pin endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'liveChatActionEndpoint', 'live_chat/live_chat_action');
        } else if (msg.action === ChatUserActions.TIMEOUT_USER) {
          const serviceEndpoint = findNestedOptionEndpoint(
            res,
            'HOURGLASS',
            msg.actionOption,
            'moderateLiveChatEndpoint'
          );
          if (serviceEndpoint == null) {
            throw new Error('Could not find timeout endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint', 'live_chat/moderate');
        } else if (msg.action === ChatUserActions.HIDE_USER) {
          const serviceEndpoint = findMenuEndpoint(res, 'REMOVE_CIRCLE', 'moderateLiveChatEndpoint', [
            (label) => label.includes('hide user')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find hide endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint', 'live_chat/moderate');
        } else if (msg.action === ChatUserActions.UNHIDE_USER) {
          const serviceEndpoint = findMenuEndpoint(res, 'ADD_CIRCLE', 'moderateLiveChatEndpoint', [
            (label) => label.includes('unhide user')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find unhide endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'moderateLiveChatEndpoint', 'live_chat/moderate');
        } else if (msg.action === ChatUserActions.ADD_MODERATOR) {
          const serviceEndpoint = findNestedOptionEndpoint(
            res,
            'ADD_MODERATOR',
            msg.actionOption,
            'manageLiveChatUserEndpoint'
          );
          if (serviceEndpoint == null) {
            throw new Error('Could not find add moderator endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'manageLiveChatUserEndpoint', 'live_chat/manage_user');
        } else if (msg.action === ChatUserActions.REMOVE_MODERATOR) {
          const serviceEndpoint = findMenuEndpoint(res, 'REMOVE_MODERATOR', 'manageLiveChatUserEndpoint', [
            (label) => label.includes('remove') && label.includes('moderator')
          ]);
          if (serviceEndpoint == null) {
            throw new Error('Could not find remove moderator endpoint in context menu');
          }
          await postEndpoint(serviceEndpoint, 'manageLiveChatUserEndpoint', 'live_chat/manage_user');
        } else if (msg.action === ChatUserActions.REPORT_USER) {
          const apiKey = ytcfg.data_.INNERTUBE_API_KEY;
          const serviceEndpoint = findMenuEndpoint(res, 'FLAG', 'getReportFormEndpoint', [
            (label) => label.includes('report')
          ]) ?? findServiceEndpoint(res, 'getReportFormEndpoint');
          if (serviceEndpoint == null) {
            throw new Error('Could not find report endpoint in context menu');
          }
          const { params, context } = parseServiceEndpoint(serviceEndpoint, 'getReportFormEndpoint');
          const modal = await fetcher(`${currentDomain}/youtubei/v1/flag/get_form?key=${apiKey}&prettyPrint=false`, {
            ...heads,
            body: JSON.stringify({
              params,
              context
            })
          });
          const options = modal?.actions?.[0]
            ?.openPopupAction?.popup?.reportFormModalRenderer
            ?.optionsSupportedRenderers?.optionsRenderer?.items;
          if (!Array.isArray(options) || options.length < 1) {
            throw new Error('Report options are missing');
          }
          const reportIndex = chatReportUserOptions.findIndex(d => d.value === msg.reportOption);
          const index = reportIndex >= 0 && reportIndex < options.length ? reportIndex : 0;
          const submitEndpoint = options[index]?.optionSelectableItemRenderer?.submitEndpoint;
          const clickTrackingParams = submitEndpoint?.clickTrackingParams;
          const flagAction = submitEndpoint?.flagEndpoint?.flagAction;
          if (flagAction == null) {
            throw new Error('Report submit endpoint is missing');
          }
          if (clickTrackingParams != null) {
            context.clickTracking = {
              clickTrackingParams
            };
          }
          const flagResponse = await fetcher(`${currentDomain}/youtubei/v1/flag/flag?key=${apiKey}&prettyPrint=false`, {
            ...heads,
            body: JSON.stringify({
              action: flagAction,
              context
            })
          });
          if (flagResponse?.error != null || flagResponse?.success === false) {
            throw new Error('Report request failed');
          }
        } else {
          throw new Error(`Unknown chat action: ${msg.action as string}`);
        }
      } catch (e) {
        console.debug('Error executing chat action', e);
        success = false;
      }
      port.postMessage({
        type: 'chatUserActionResponse',
        action: msg.action,
        message,
        success
      });
    });
  });

  // Inject interceptor script
  const script = document.createElement('script');
  script.innerHTML = `(${injectedFunction.toString()})();`;
  document.body.appendChild(script);

  // Handle initial data
  const scripts = document.querySelector('body')?.querySelectorAll('script');
  if (!scripts) {
    console.error('Unable to get script elements.');
    return;
  }
  for (const script of Array.from(scripts)) {
    const start = 'window["ytInitialData"] = ';
    const text = script.text;
    if (!text || !text.startsWith(start)) {
      continue;
    }
    const json = text.replace(start, '').slice(0, -1);
    port.postMessage({
      type: 'setInitialData',
      json
    });
    break;
  }

  // Catch YT messages
  window.addEventListener('message', (d) => {
    if (d.data['yt-player-video-progress'] != null) {
      port.postMessage({
        type: 'updatePlayerProgress',
        playerProgress: d.data['yt-player-video-progress'],
        isFromYt: true
      });
    }
  });

  // Update dark theme whenever it changes
  let wasDark: boolean | undefined;
  const html = document.documentElement;
  const sendTheme = (): void => {
    const isDark = html.hasAttribute('dark');
    if (isDark === wasDark) return;
    port.postMessage({
      type: 'setTheme',
      dark: isDark
    });
    wasDark = isDark;
  };
  new MutationObserver(sendTheme).observe(html, {
    attributes: true
  });
  sendTheme();

  // Inject mem leak fix script
  const fixLeakScript = document.createElement('script');
  fixLeakScript.innerHTML = `(${fixLeaks.toString()})();`;
  document.body.appendChild(fixLeakScript);
};

if (isLiveTL) {
  chatLoaded().catch(console.error);
} else {
  setTimeout(() => {
    chatLoaded().catch(console.error);
  }, 500);
}
