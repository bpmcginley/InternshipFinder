const PROFILE_FIELDS = ["first_name","last_name","email","phone","city","linkedin","github","website","school","degree","major","grad_term","gpa","work_authorized","needs_sponsorship","how_heard","background","country","resume_text","address_line1","state","postal_code"];

function getStored(keys){ return new Promise(res=>chrome.storage.local.get(keys, res)); }
function readFile(inputEl){
  return new Promise(res=>{
    const f = inputEl.files && inputEl.files[0];
    if(!f) return res(null);
    const r = new FileReader();
    r.onload = ()=>res({ name:f.name, type:f.type, data:r.result });
    r.onerror = ()=>res(null);
    r.readAsDataURL(f);
  });
}
function fileStatus(id, stored){
  const el = document.getElementById(id);
  el.textContent = stored && stored.name ? ("saved: " + stored.name) : "none saved";
}

function load(){
  chrome.storage.local.get(["internscout","ai","files"],(d)=>{
    const p=d.internscout||{}, ai=d.ai||{}, files=d.files||{};
    PROFILE_FIELDS.forEach(k=>{ if(document.getElementById(k)!=null && p[k]!=null) document.getElementById(k).value=p[k]; });
    document.getElementById("apiKey").value = ai.apiKey||"";
    document.getElementById("model").value = ai.model||"claude-haiku-4-5-20251001";
    fileStatus("resume_status", files.resume);
    fileStatus("transcript_status", files.transcript);
  });
}

async function save(){
  const p={}; PROFILE_FIELDS.forEach(k=>{ p[k]=document.getElementById(k).value; });
  const d = await getStored(["internscout","files"]);
  p.templates = (d.internscout&&d.internscout.templates) || {"why":"I'm excited about {{company}} because the work aligns with my background and I'm eager to contribute and learn. "};
  const ai = { apiKey:document.getElementById("apiKey").value.trim(), model:document.getElementById("model").value.trim()||"claude-haiku-4-5-20251001", provider:"anthropic" };
  // merge files: keep existing unless a new file was chosen
  const files = Object.assign({}, d.files||{});
  const rf = await readFile(document.getElementById("resume_file"));   if(rf) files.resume = rf;
  const tf = await readFile(document.getElementById("transcript_file")); if(tf) files.transcript = tf;
  chrome.storage.local.set({internscout:p, ai, files},()=>{
    const s=document.getElementById("saved"); s.textContent="Saved ✓"; setTimeout(()=>s.textContent="",2000);
    fileStatus("resume_status", files.resume);
    fileStatus("transcript_status", files.transcript);
  });
}

document.getElementById("save").addEventListener("click",save);
load();
