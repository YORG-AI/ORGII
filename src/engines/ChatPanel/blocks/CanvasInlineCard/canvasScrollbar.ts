export const ISOLATED_CANVAS_SCROLLBAR_STYLES = `
  *{scrollbar-gutter:auto;scrollbar-width:thin;scrollbar-color:transparent transparent;}
  ::-webkit-scrollbar{width:var(--scrollbar-hit-area-size,12px);height:var(--scrollbar-hit-area-size,12px);background:transparent;}
  ::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent;}
  ::-webkit-scrollbar-thumb,::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{background:transparent;background-clip:padding-box;border:var(--scrollbar-edge-inset,3px) solid transparent;border-radius:calc(var(--scrollbar-hit-area-size,12px)/2);}
  [data-scrollbar-scrolling]{scrollbar-color:var(--scrollbar-thumb-color,rgba(128,128,128,.72)) transparent;}
  [data-scrollbar-scrolling]::-webkit-scrollbar-thumb,[data-scrollbar-scrolling]::-webkit-scrollbar-thumb:hover,[data-scrollbar-scrolling]::-webkit-scrollbar-thumb:active{background:var(--scrollbar-thumb-color,rgba(128,128,128,.72));background-clip:padding-box;border:var(--scrollbar-edge-inset,3px) solid transparent;border-radius:calc(var(--scrollbar-hit-area-size,12px)/2);}
`;

/**
 * One bounded activity observer for a sandboxed Canvas document. The iframe
 * owns the listener and timer, and destroying the document releases both.
 */
export const ISOLATED_CANVAS_SCROLLBAR_SCRIPT = `
(()=>{
  const attribute='data-scrollbar-scrolling';
  const hideDelayMs=900;
  let activeElement=null;
  let lastActivityAt=0;
  let hideTimeout=null;
  const hideActive=()=>{
    if(hideTimeout!==null){clearTimeout(hideTimeout);hideTimeout=null;}
    if(activeElement){activeElement.removeAttribute(attribute);activeElement=null;}
  };
  const scheduleHide=()=>{
    if(hideTimeout!==null)return;
    const checkActivity=()=>{
      hideTimeout=null;
      const remaining=hideDelayMs-(Date.now()-lastActivityAt);
      if(remaining>0){hideTimeout=setTimeout(checkActivity,remaining);return;}
      hideActive();
    };
    hideTimeout=setTimeout(checkActivity,hideDelayMs);
  };
  const reveal=element=>{
    if(document.visibilityState==='hidden'){hideActive();return;}
    lastActivityAt=Date.now();
    if(activeElement!==element){
      if(activeElement)activeElement.removeAttribute(attribute);
      activeElement=element;
      activeElement.setAttribute(attribute,'');
    }
    scheduleHide();
  };
  document.addEventListener('scroll',event=>{
    const element=event.target instanceof Element
      ? event.target
      : document.scrollingElement||document.documentElement;
    if(element)reveal(element);
  },{capture:true,passive:true});
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden')hideActive();
  });
})();
`;
