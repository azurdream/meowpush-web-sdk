const input = document.querySelector('#push-key');
const controller = MeowPushConnect.mountButton('#connect', {
  application: {
    name: 'Example Service',
    description: 'Receive a notification when a task finishes',
    websiteUrl: 'https://service.example',
    iconUrl: 'https://service.example/icon.png',
  },
  locale: 'en',
  onSuccess({ pushKey }) { input.value = pushKey; input.dispatchEvent(new Event('input', { bubbles: true })); },
});
document.querySelector('#notification-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#saved').textContent = input.value ? 'Demo settings saved for this page only.' : 'Enter a push key first.';
});
window.addEventListener('pagehide', () => controller.destroy(), { once: true });
