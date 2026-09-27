// Opens a short onboarding page the first time the extension is installed,
// so a new user doesn't need anyone to explain the 3 steps to them.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') });
  }
});
