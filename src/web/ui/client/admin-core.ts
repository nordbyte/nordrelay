function downloadBase64(name,dataBase64,mimeType){const bytes=Uint8Array.from(atob(dataBase64),c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:mimeType});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href)}
function card(title,rows){return uiCard(title,rows)}
function safe(fn,event=null){if(event&&event.preventDefault)event.preventDefault();Promise.resolve().then(fn).catch(err=>toast(err.message||String(err)))}
loadBootstrap().then(()=>connectEvents()).catch(err=>toast(err.message));
