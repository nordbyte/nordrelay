function currentPluginPanelTheme(){return document.documentElement.dataset.theme==='dark'?'dark':'light'}
function currentPluginPanelNonce(){
  const script=document.querySelector('script[nonce]') as HTMLScriptElement|null;
  const style=document.querySelector('style[nonce]') as HTMLStyleElement|null;
  return script?.nonce||script?.getAttribute('nonce')||style?.nonce||style?.getAttribute('nonce')||'';
}
function pluginPanelNonceAttr(){
  const nonce=currentPluginPanelNonce();
  return nonce?' nonce="'+attr(nonce)+'"':'';
}
function ensurePluginPanelStyles(){
  // The shared plugin panel CSS is bundled with the WebUI stylesheet. Keeping
  // this hook lets future dynamic plugin CSS use the same lifecycle without
  // reintroducing iframe-specific style injection.
}
function createPluginPanelInstanceId(){
  const cryptoApi=(globalThis as WebuiRecord).crypto as WebuiRecord|undefined;
  if(cryptoApi&&typeof cryptoApi.randomUUID==='function')return String(cryptoApi.randomUUID());
  return 'panel-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
}
function pluginPanelExtractExecutableHtml(html){
  const template=document.createElement('template');
  template.innerHTML=String(html||'');
  const scripts:Array<{code:string;source:string;placeholder:string}>=[];
  template.content.querySelectorAll('script').forEach((script,index)=>{
    const placeholder='plugin-script-'+Date.now().toString(36)+'-'+index+'-'+Math.random().toString(36).slice(2);
    const marker=document.createElement('span');
    marker.hidden=true;
    marker.dataset.pluginPanelScriptPlaceholder=placeholder;
    scripts.push({code:script.textContent||'',source:script.getAttribute('src')||'',placeholder});
    script.replaceWith(marker);
  });
  const styles:Array<{code:string;placeholder:string}>=[];
  template.content.querySelectorAll('style').forEach((style,index)=>{
    const placeholder='plugin-style-'+Date.now().toString(36)+'-'+index+'-'+Math.random().toString(36).slice(2);
    const marker=document.createElement('span');
    marker.hidden=true;
    marker.dataset.pluginPanelStylePlaceholder=placeholder;
    styles.push({code:style.textContent||'',placeholder});
    style.replaceWith(marker);
  });
  const holder=document.createElement('div');
  holder.appendChild(template.content.cloneNode(true));
  return{html:holder.innerHTML,scripts,styles};
}
function pluginPanelInlineHtml(html,title,options:WebuiRecord={},className=''){
  const instanceId=createPluginPanelInstanceId();
  const classes=['plugin-panel-surface',String(className||'').trim()].filter(Boolean).join(' ');
  return '<div class="'+attr(classes)+'" data-plugin-panel-surface data-plugin-panel-instance="'+attr(instanceId)+'" data-plugin-id="'+attr(options.pluginId||'')+'" data-plugin-panel-id="'+attr(options.capabilityId||options.panelId||'')+'" data-plugin-title="'+attr(title)+'">'+html+'</div>';
}
function cleanupPluginPanelSurfaces(root:ParentNode=document){
  root.querySelectorAll?.('[data-plugin-panel-surface]').forEach(surface=>cleanupPluginPanelSurface(surface as HTMLElement));
}
function cleanupPluginPanelSurface(surface:HTMLElement|null){
  if(!surface)return;
  const registry=pluginPanelRegistry();
  const instanceId=surface.dataset.pluginPanelInstance||'';
  registry.cleanup(instanceId);
}
function isPluginPanelSurfaceVisible(surface:HTMLElement|null){
  if(!surface||!surface.isConnected||surface.hidden)return false;
  const page=surface.closest('.page');
  return !page||page.classList.contains('active');
}
type PluginPanelApi = {
  id: string;
  root: HTMLElement;
  reload: (input?: WebuiRecord) => Promise<void> | void;
  invokeCommand: (command: unknown, input?: WebuiRecord, options?: WebuiRecord) => Promise<unknown>;
  toast: (message: unknown, options?: WebuiRecord) => void;
  copyText: (value: unknown, label?: unknown) => void;
  setInterval: (fn: () => void, ms: unknown) => number;
  setTimeout: (fn: () => void, ms: unknown) => number;
  addEventListener: (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void;
  isVisible: () => boolean;
  isActivePage: () => boolean;
  onCleanup: (fn: () => void) => void;
  cleanup: () => void;
};
type PluginPanelRegistry = {
  register: (instanceId: string, surface: HTMLElement, reload: (input: WebuiRecord) => Promise<void> | void) => PluginPanelApi;
  api: (instanceId: string) => PluginPanelApi | null;
  cleanup: (instanceId: string) => void;
};
function pluginPanelRegistry():PluginPanelRegistry{
  const global=globalThis as WebuiRecord;
  if(global.NordRelayPluginPanels&&typeof global.NordRelayPluginPanels==='object')return global.NordRelayPluginPanels as PluginPanelRegistry;
  const instances=new Map<string,WebuiRecord>();
  const registry:PluginPanelRegistry={
    register(instanceId:string,surface:HTMLElement,reload:(input:WebuiRecord)=>Promise<void>|void){
      this.cleanup(instanceId);
      const cleanup:Array<()=>void>=[];
      const panelApi={
        id:instanceId,
        root:surface,
        reload:(input:WebuiRecord={})=>reload(input&&typeof input==='object'?input:{}),
        invokeCommand:(command:unknown,input:WebuiRecord={},options:WebuiRecord={})=>{
          const pluginId=surface.dataset.pluginId||'';
          if(!pluginId)throw new Error('Plugin panel has no plugin id.');
          const requestPath=('/api/plugins/'+encodeURIComponent(pluginId)+'/command') as `/api/plugins/${string}/command`;
          const peerId=String(options.peerId||input.peerId||'local');
          const timeoutMs=Math.max(1000,Number(options.timeoutMs)||600000);
          const payload={method:'POST' as const,body:JSON.stringify({command:String(command||''),input:input&&typeof input==='object'?input:{}}),timeoutMs};
          return peerId&&peerId!=='local'?apiPeer(peerId,requestPath,payload):api(requestPath,{...payload,local:true});
        },
        toast:(message:unknown,options?:WebuiRecord)=>toast(String(message||'Plugin panel'),options as {duration?:number;sticky?:boolean}|undefined),
        copyText:(value:unknown,label?:unknown)=>copyText(String(value||''),label?String(label):'Copied'),
        setInterval:(fn:()=>void,ms:unknown)=>{
          const id=window.setInterval(fn,Math.max(100,Number(ms)||1000));
          cleanup.push(()=>window.clearInterval(id));
          return id;
        },
        setTimeout:(fn:()=>void,ms:unknown)=>{
          const id=window.setTimeout(fn,Math.max(0,Number(ms)||0));
          cleanup.push(()=>window.clearTimeout(id));
          return id;
        },
        addEventListener:(target:EventTarget,type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
          target.addEventListener(type,listener,options);
          cleanup.push(()=>target.removeEventListener(type,listener,options));
        },
        isVisible:()=>isPluginPanelSurfaceVisible(surface),
        isActivePage:()=>isPluginPanelSurfaceVisible(surface),
        onCleanup:(fn:()=>void)=>{if(typeof fn==='function')cleanup.push(fn)},
        cleanup:()=>registry.cleanup(instanceId),
      };
      instances.set(instanceId,{surface,api:panelApi,cleanup});
      return panelApi;
    },
    api(instanceId:string){
      return (instances.get(instanceId)?.api as PluginPanelApi|undefined)||null;
    },
    cleanup(instanceId:string){
      const entry=instances.get(instanceId);
      if(!entry)return;
      instances.delete(instanceId);
      const cleanup=Array.isArray(entry.cleanup)?entry.cleanup:[];
      for(const fn of cleanup.reverse()){
        try{if(typeof fn==='function')fn()}catch{}
      }
    },
  };
  global.NordRelayPluginPanels=registry;
  return registry;
}
function executePluginPanelCode(surface:HTMLElement,instanceId:string,code:string,source='plugin panel script'){
  if(!code.trim())return;
  const script=document.createElement('script');
  const nonce=currentPluginPanelNonce();
  if(nonce)script.setAttribute('nonce',nonce);
  script.dataset.pluginPanelExecutable=source;
  script.textContent='(function(){const api=window.NordRelayPluginPanels&&window.NordRelayPluginPanels.api('+JSON.stringify(instanceId)+');if(!api)return;\n'+code+'\n}).call(window);';
  surface.appendChild(script);
}
function executePluginPanelScriptAtPlaceholder(surface:HTMLElement,instanceId:string,placeholder:string,code:string,source='inline script'){
  const marker=surface.querySelector('[data-plugin-panel-script-placeholder="'+cssEscape(placeholder)+'"]');
  if(!marker){executePluginPanelCode(surface,instanceId,code,source);return}
  const script=document.createElement('script');
  const nonce=currentPluginPanelNonce();
  if(nonce)script.setAttribute('nonce',nonce);
  script.dataset.pluginPanelExecutable=source;
  script.textContent='(function(){const api=window.NordRelayPluginPanels&&window.NordRelayPluginPanels.api('+JSON.stringify(instanceId)+');if(!api)return;\n'+code+'\n}).call(window);';
  marker.replaceWith(script);
}
function insertPluginPanelStyleAtPlaceholder(surface:HTMLElement,placeholder:string,code:string){
  if(!code.trim())return;
  const marker=surface.querySelector('[data-plugin-panel-style-placeholder="'+cssEscape(placeholder)+'"]');
  const style=document.createElement('style');
  const nonce=currentPluginPanelNonce();
  if(nonce)style.setAttribute('nonce',nonce);
  style.dataset.pluginPanelStyle='inline';
  style.textContent=code;
  if(marker)marker.replaceWith(style);
  else surface.appendChild(style);
}
function bindPluginPanelSurface(surface:HTMLElement,item:WebuiRecord,result:WebuiRecord,input:WebuiRecord={}){
  if(!surface||surface.dataset.pluginPanelBound)return;
  surface.dataset.pluginPanelBound='true';
  ensurePluginPanelStyles();
  const instanceId=surface.dataset.pluginPanelInstance||createPluginPanelInstanceId();
  surface.dataset.pluginPanelInstance=instanceId;
  const registry=pluginPanelRegistry();
  registry.register(instanceId,surface,async(nextInput:WebuiRecord={})=>{
    const reload=(globalThis as WebuiRecord).reloadPluginPanelSurface;
    if(typeof reload==='function')await reload(surface,{...input,...(nextInput&&typeof nextInput==='object'?nextInput:{})});
  });
  const allowClientScript=Boolean(item.allowClientScript);
  const panel=(result.panel&&typeof result.panel==='object'&&!Array.isArray(result.panel)?result.panel:{}) as WebuiRecord;
  const styles=Array.isArray(result.__pluginPanelStyles)?result.__pluginPanelStyles:[];
  styles.forEach((entry:WebuiRecord)=>insertPluginPanelStyleAtPlaceholder(surface,String(entry.placeholder||''),String(entry.code||'')));
  if(panel.styles&&typeof panel.styles==='string')insertPluginPanelStyleAtPlaceholder(surface,'',panel.styles);
  if(!allowClientScript){
    const scriptsBlocked=(Array.isArray(result.__pluginPanelScripts)&&result.__pluginPanelScripts.length>0)||Boolean(panel.script);
    if(scriptsBlocked)surface.insertAdjacentHTML('afterbegin','<div class="callout warn">This plugin panel includes client-side script, but allowClientScript is not enabled in the plugin manifest.</div>');
    return;
  }
  const scripts=Array.isArray(result.__pluginPanelScripts)?result.__pluginPanelScripts:[];
  scripts.forEach((entry:WebuiRecord)=>{
    if(entry.source)surface.insertAdjacentHTML('beforeend','<div class="callout warn">External plugin panel scripts are not loaded: '+esc(entry.source)+'</div>');
    else executePluginPanelScriptAtPlaceholder(surface,instanceId,String(entry.placeholder||''),String(entry.code||''),'inline script');
  });
  if(panel.script&&typeof panel.script==='string')executePluginPanelCode(surface,instanceId,panel.script,'panel script');
}
function syncPluginPanelThemes(){}
