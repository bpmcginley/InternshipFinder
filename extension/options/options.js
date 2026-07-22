const PROFILE_FIELDS = ["first_name","last_name","email","phone","city","linkedin","github","website","school","degree","major","grad_term","gpa","work_authorized","needs_sponsorship","how_heard","background","country","resume_text"];
function load(){
  chrome.storage.local.get(["internscout","ai"],(d)=>{
    const p=d.internscout||{}, ai=d.ai||{};
    PROFILE_FIELDS.forEach(k=>{ if(document.getElementById(k)!=null && p[k]!=null) document.getElementById(k).value=p[k]; });
    document.getElementById("apiKey").value = ai.apiKey||"";
    document.getElementById("model").value = ai.model||"claude-haiku-4-5-20251001";
  });
}
function save(){
  const p={}; PROFILE_FIELDS.forEach(k=>{ p[k]=document.getElementById(k).value; });
  // preserve existing templates
  chrome.storage.local.get(["internscout"],(d)=>{
    p.templates=(d.internscout&&d.internscout.templates)|| {"why":"I'm excited about {{company}} because the work aligns with my background and I'm eager to contribute and learn. "};
    const ai={apiKey:document.getElementById("apiKey").value.trim(), model:document.getElementById("model").value.trim()||"claude-haiku-4-5-20251001", provider:"anthropic"};
    chrome.storage.local.set({internscout:p, ai},()=>{ const s=document.getElementById("saved"); s.textContent="Saved ✓"; setTimeout(()=>s.textContent="",2000); });
  });
}
document.getElementById("save").addEventListener("click",save);
load();
