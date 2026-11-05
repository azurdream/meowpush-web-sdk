# @azurdream/meowpush-app-connect

Connect a web application to [MeowPush](https://meowpush.com) through explicit user authorization. Use the built-in button or a headless function to receive an application push key. No runtime dependencies.

## Install

```sh
pnpm add @azurdream/meowpush-app-connect
```

## Connection button

```js
import { mountButton } from '@azurdream/meowpush-app-connect/ui';
import '@azurdream/meowpush-app-connect/styles.css';

const connection = mountButton('#connect-meowpush', {
  application: {
    name: 'Example Service',
    description: 'Receive a notification when a task finishes',
    websiteUrl: 'https://service.example',
    iconUrl: 'https://service.example/icon.png',
  },
  onSuccess({ pushKey }) {
    // Now you get the user authorized push key.
    // Fill out on the form or save it.
  },
});
```

Provide a dedicated container such as `<div id="connect-meowpush"></div>`. The component owns only its inserted nodes and never discovers inputs or submits your form. Each successful authorization creates a new MeowPush Application.

The button handles the authorization window, progress, cancellation and retries. It provides a recovery link if the window is closed or blocked, then returns the push key through `onSuccess`. Call `connection.destroy()` when removing the component or switching account/settings context.

Set `iconUrl` to your service's own publicly accessible HTTPS icon, and replace the example name, description and website with your application's details.

## Presentation

Configure `label`, `locale: 'auto' | 'zh-CN' | 'en'`, `theme: 'auto' | 'light' | 'dark'` and `size: 'sm' | 'md'`. By default, the button follows the browser language and system appearance, with English as the language fallback.

```js
connection.update({ locale: 'en', theme: 'dark', size: 'sm' });
connection.update({ theme: undefined }); // Restore automatic appearance.
connection.cancel(); // Stop an active operation.
```

Use `update()` to change presentation during an active connection. The stylesheet supports reduced motion, keyboard interaction and accessible status feedback. The button icon needs `img-src https://meowpush.com` in your CSP, and API requests need `connect-src https://accounts.meowpush.com`.

## Custom UI with other frameworks

Use `connect()` inside your own component to fill a settings field after authorization. This React example provides its own controls, handles cancellation and cancels an active request when the component unmounts.

```jsx
import { useEffect, useRef, useState } from 'react';
import { connect } from '@azurdream/meowpush-app-connect';

export default function NotificationSettings() {
  const [pushKey, setPushKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [error, setError] = useState('');
  const activeRequest = useRef(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  async function handleConnect() {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setConnecting(true);
    setError('');

    try {
      const result = await connect({
        application: {
          name: 'Example Service',
          description: 'Receive a notification when a task finishes',
          websiteUrl: 'https://service.example',
          iconUrl: 'https://service.example/icon.png',
        },
        signal: controller.signal,
        onAuthorizationReady: ({ url }) => setAuthorizationUrl(url),
        onAuthorizationRequired: ({ url }) => setAuthorizationUrl(url),
      });
      if (!controller.signal.aborted) setPushKey(result.pushKey);
    } catch {
      if (!controller.signal.aborted) setError('Connection failed. Please try again.');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) {
        setConnecting(false);
        setAuthorizationUrl('');
      }
    }
  }

  function handleCancel() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setConnecting(false);
    setAuthorizationUrl('');
  }

  return (
    <section>
      <label>
        Application push key
        <input
          type="password"
          autoComplete="off"
          value={pushKey}
          onChange={(event) => setPushKey(event.target.value)}
        />
      </label>
      <button type="button" disabled={connecting} onClick={handleConnect}>
        {connecting ? 'Connecting…' : 'Connect notifications'}
      </button>
      {connecting && <button type="button" onClick={handleCancel}>Cancel</button>}
      {authorizationUrl && (
        <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          Open authorization page
        </a>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
```

Save `pushKey` through your form's normal submission. Call `connect()` directly from a user interaction so the browser can open the authorization window. `onStateChange` is available for custom progress feedback.

`authorization.mode` supports `popup` (default), `tab`, and `manual`. Manual mode requires `onAuthorizationRequired`. Popup defaults to a requested 680 × 900 window centered near the current browser window. Set `position: 'browser-default'` to use the browser's placement, or provide `width` and `height`.

## Plain script

Load the script and stylesheet from the same CDN release. The following example follows the latest stable release:

```html
<link
  rel="stylesheet"
  href="https://dstatic.meowpush.com/meowpush-app-connect/latest/styles.css"
  crossorigin="anonymous"
>

<label for="meowpush-key">Application push key</label>
<input id="meowpush-key" name="push_key" type="password" autocomplete="off">
<div id="connect-meowpush"></div>

<script
  src="https://dstatic.meowpush.com/meowpush-app-connect/latest/connect.min.js"
  crossorigin="anonymous"
></script>
<script>
  const pushKeyInput = document.querySelector('#meowpush-key');
  const connection = MeowPushConnect.mountButton('#connect-meowpush', {
    application: {
      name: 'Example Service',
      description: 'Receive a notification when a task finishes',
      websiteUrl: 'https://service.example',
      iconUrl: 'https://service.example/icon.png',
    },
    onSuccess({ pushKey }) {
      pushKeyInput.value = pushKey;
      pushKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
</script>
```

The inline script contains your application's setup and callback. Save the filled input through your settings form, and call `connection.destroy()` if you remove its container in a single-page app.

The `examples/` directory contains a complete form example. For a pinned build, replace `latest` in both URLs with a released package version such as `1.2.3`. Copy the matching SHA-384 values from that version's `integrity.json` into the HTML `integrity` attributes. Pinned URLs support long-term caching. The `latest` URLs revalidate on reuse.

## Security and errors

Core and UI imports are SSR-safe; invoke them only in the browser. The hosting page must use HTTPS or local HTTP (`localhost`, `127.0.0.1`, `[::1]`). API and authorization origins are fixed to the official MeowPush service.

Errors expose stable `ConnectError.code` and `retryable` values, never raw responses, invitations or credentials. Common codes include `network_error`, `request_timeout`, `rate_limited`, `server_unavailable`, `rejected`, `expired`, `invalidated` and `cancelled`. Polling retries transient errors a bounded number of times; creation requests are never automatically replayed after a lost response.

The SDK does not persist credentials or emit global credential events. Never log callback results, invitation URLs or request/response bodies. Your application is responsible for securely saving the returned push key through its existing settings flow. An authorization deadline is not a push-key lifetime. Applications can be revoked through MeowPush application management.
