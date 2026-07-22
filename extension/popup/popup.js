document.getElementById("fill").addEventListener("click",()=>{
  chrome.tabs.query({active:true,currentWindow:true},(tabs)=>{
    if(!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id,{type:"fill"},()=>{
      if(chrome.runtime.lastError) document.getElementById("s").textContent="Open a Greenhouse/Lever application page first.";
      else window.close();
    });
  });
});
document.getElementById("opt").addEventListener("click",(e)=>{e.preventDefault();chrome.runtime.openOptionsPage();});
