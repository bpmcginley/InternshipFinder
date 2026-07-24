const S = document.getElementById("s");
document.getElementById("fill").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !/^https?:/.test(tab.url || "")) { S.textContent = "Open a job application page first."; return; }
    S.textContent = "Injecting…";
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, files: ["src/profile.js", "src/matcher.js", "src/workday.js", "src/content.js"] },
      () => {
        if (chrome.runtime.lastError) { S.textContent = "Can't run on this page."; return; }
        chrome.tabs.sendMessage(tab.id, { type: "aifill" }, () => { window.close(); });
      });
  });
});
document.getElementById("opt").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
