import { colourOf } from "./colourof.js";

/**
 * The documents an HTML page runs as: the page itself, held in a wrapper.
 *
 * Both are sandboxed srcdoc frames on opaque origins. Each layer stops
 * something the others do not, and each was proven in Chrome by a page trying
 * every way out (artifact.chrome.test.ts):
 *
 *  - The sandbox (scripts only) stops popups, forms, downloads' windows, and
 *    navigating the dashboard or any frame but the page's own.
 *  - The page's policy, first in its head, allows no network: no fetch, no
 *    socket, no external script, style, image, font, object or frame.
 *  - The wrapper's policy says what the page's frame may load: about: and
 *    nothing else. A frame's navigation is checked against its parent's
 *    policy, so a page sending itself elsewhere (location, a link, a meta
 *    refresh) is refused before any request goes; and since a srcdoc frame
 *    inherits its parent's policy, the page can only narrow it, never widen it.
 *  - Trusted Types and the guard script, which run before the page's own,
 *    keep the page from making a <link>, <meta>, <iframe>, <form> or
 *    <script>, which no policy covers: `<link rel=prerender>` makes a real
 *    request whatever the policy says, and a new frame is a fresh realm. The
 *    page's own markup is held to the same at write time (htmlpage.ts).
 *
 * What still leaves: Chrome opens a connection (a DNS lookup and a TCP
 * connect, no request) to the host a navigation is aimed at, before it checks
 * the policy. No path, query or body is sent. An opaque frame has no
 * Navigation API to cancel the navigation earlier, so this one is held at
 * write time only.
 */

/** The kinds whose frame is as tall as their content; a deck keeps its stage and a sheet its grid. */
export const FIT_KINDS: readonly string[] = ["page", "doc"];

/** Whether an artifact of this kind takes its content's height in the dashboard. */
export const fitsContent = (kind: string | undefined): boolean => FIT_KINDS.includes(kind ?? "page");

/** The tallest the dashboard lets a page's frame grow: the height is the page's to say, so it is capped. */
export const FRAME_HEIGHT_MAX = 50_000;

/**
 * Queries one frame has with the server at once. The server lets a page have
 * one running and four waiting (pagequeries.ts); the bridge holds the rest,
 * so a page that asks for ten at once gets ten answers, and two frames of the
 * same artifact (the viewer and a check's render) still fit.
 */
export const FRAME_QUERIES = 2;

/**
 * How long a frame waits on one query's answer before giving its turn up:
 * the server stops a query at 2 s, so a reply this late is one that is not
 * coming (the relay dropped it, the dashboard went away). It is refused in
 * words the page can show, and a late answer is ignored.
 */
export const FRAME_QUERY_WAIT_MS = 10_000;

/** What a page may load: nothing from the network. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The page's own policy on top: no frames at all, and HTML only through the guard. */
export const PAGE_GUARD_CSP = `${PAGE_CSP}; frame-src 'none'; child-src 'none'; require-trusted-types-for 'script'; trusted-types default`;

/** The wrapper's: what the page's frame may navigate to, which is about: alone. */
export const WRAPPER_CSP = `${PAGE_CSP}; frame-src about:`;

/**
 * What runs before anything the page wrote.
 *
 * The elements no Content Security Policy governs (a <link>, which can
 * prerender; a <meta>, which can refresh; a frame, a fresh realm; a <form>, a
 * <base>, a <script>) are kept off the page at every way an element is made
 * or placed, whatever namespace it claims:
 *
 *  - Trusted Types send every string the page turns into HTML through one
 *    policy, which refuses their markup, prefixed or not; where a browser
 *    has no Trusted Types, the same refusal is set on each of those sinks
 *    (innerHTML, outerHTML, insertAdjacentHTML, document.write, DOMParser,
 *    ranges, setHTML, setHTMLUnsafe) instead, so the rest of the guard still
 *    runs; and editing's insertHTML command, which no policy covers, is held
 *    to the same refusal in every browser;
 *  - the factories (createElement, createElementNS, createDocument) refuse
 *    them by name;
 *  - and since a parser can still make one (an XML document's entities, a
 *    document made elsewhere), nothing holding one may be adopted, imported
 *    or put into a document, by any of the methods that place a node.
 *
 * A <link> that exists anyway takes no rel or href. XSLT, which builds
 * elements from data, is taken away; WebRTC is RTC_GUARD's, before this. Every replacement is fixed in place, and what it checks
 * with (a node's type and name, querySelector) is held from before the page
 * could change it.
 */
export const GUARD_SCRIPT = String.raw`(function(){
"use strict";
var R=Reflect.apply,Str=String,exec=RegExp.prototype.exec,lower=String.prototype.toLowerCase,cut=String.prototype.slice,last=String.prototype.lastIndexOf,define=Object.defineProperty;
var TAGS="link,meta,iframe,frame,frameset,object,embed,base,form,portal,fencedframe,script";
var BAD=Object.create(null);TAGS.split(",").forEach(function(t){BAD[t]=true});
var ATTRS=Object.create(null);["rel","href","as","imagesrcset","imagesizes","http-equiv","content","src","action","target"].forEach(function(a){ATTRS[a]=true});
var inMarkup=new RegExp("<\\/?([\\w-]+:)?("+TAGS.replace(/,/g,"|")+")(?![\\w-])","i"),inXsl=/xsl:/i;
function refuse(what){throw new TypeError("A KOS page cannot make "+what+": it has no network to use it.")}
function fix(o,k,v){define(o,k,{value:v,writable:false,configurable:false})}
function getter(o,k){return Object.getOwnPropertyDescriptor(o,k).get}
function local(n){var i=R(last,n,[":"]);return R(lower,R(cut,n,[i+1]),[])}
function bad(n){return BAD[local(n)]===true}
var typeOf=getter(Node.prototype,"nodeType"),nameOf=getter(Element.prototype,"localName");
var finds={1:Element.prototype.querySelector,9:Document.prototype.querySelector,11:DocumentFragment.prototype.querySelector};
function holds(n){
if(n===null||typeof n!=="object")return false;
var t;try{t=R(typeOf,n,[])}catch(_){return false}
if(t===1&&bad(R(nameOf,n,[])))return true;
var find=finds[t];return find!==undefined&&R(find,n,[TAGS])!==null}
function check(nodes){for(var i=0;i<nodes.length;i++)if(holds(nodes[i]))refuse("that element")}
function vet(s){s=Str(s);if(R(exec,inMarkup,[s])!==null||R(exec,inXsl,[s])!==null)refuse("that markup");return s}
if(typeof trustedTypes==="object"&&trustedTypes&&typeof trustedTypes.createPolicy==="function"){trustedTypes.createPolicy("default",{createHTML:vet,createScript:function(){refuse("a script")},createScriptURL:function(){refuse("a script URL")}})}
else{
var setOf=function(o,k){var d=o&&Object.getOwnPropertyDescriptor(o,k);if(!d||!d.set)return;define(o,k,{get:d.get,set:function(v){R(d.set,this,[vet(v)])},enumerable:d.enumerable,configurable:false})};
var argOf=function(o,k,i){var f=o&&o[k];if(typeof f!=="function")return;fix(o,k,function(){var a=[];for(var j=0;j<arguments.length;j++)a[j]=arguments[j];if(i<0){for(var n=0;n<a.length;n++)a[n]=vet(a[n])}else a[i]=vet(a[i]);return R(f,this,a)})};
setOf(Element.prototype,"innerHTML");setOf(Element.prototype,"outerHTML");if(typeof ShadowRoot==="function")setOf(ShadowRoot.prototype,"innerHTML");
argOf(Element.prototype,"insertAdjacentHTML",1);argOf(Element.prototype,"setHTMLUnsafe",0);if(typeof ShadowRoot==="function")argOf(ShadowRoot.prototype,"setHTMLUnsafe",0);
argOf(Document.prototype,"write",-1);argOf(Document.prototype,"writeln",-1);argOf(DOMParser.prototype,"parseFromString",0);argOf(Range.prototype,"createContextualFragment",0);argOf(Document,"parseHTMLUnsafe",0);argOf(Element.prototype,"setHTML",0);
}
var command=Document.prototype.execCommand;
if(typeof command==="function")fix(Document.prototype,"execCommand",function(c,u,v){var a=[];for(var j=0;j<arguments.length;j++)a[j]=arguments[j];if(R(lower,Str(c),[])==="inserthtml")a[2]=vet(v);return R(command,this,a)});
var make=Document.prototype.createElement,makeNS=Document.prototype.createElementNS,makeDoc=DOMImplementation.prototype.createDocument;
fix(Document.prototype,"createElement",function(n,o){n=Str(n);if(bad(n))refuse("<"+n+">");return R(make,this,[n,o])});
fix(Document.prototype,"createElementNS",function(ns,n,o){n=Str(n);if(bad(n))refuse("<"+n+">");return R(makeNS,this,[ns,n,o])});
fix(DOMImplementation.prototype,"createDocument",function(ns,n,d){n=n==null?"":Str(n);if(bad(n))refuse("<"+n+">");return R(makeDoc,this,[ns,n,d])});
function guard(o,k,pick){var f=o[k];if(typeof f!=="function")return;fix(o,k,function(){var a=[];for(var i=0;i<arguments.length;i++)a[i]=arguments[i];check(pick(a));return R(f,this,a)})}
var first=function(a){return [a[0]]},second=function(a){return [a[1]]},all=function(a){return a};
[[Document.prototype,"adoptNode",first],[Document.prototype,"importNode",first],
[Node.prototype,"appendChild",first],[Node.prototype,"insertBefore",first],[Node.prototype,"replaceChild",first],
[Element.prototype,"insertAdjacentElement",second],[Range.prototype,"insertNode",first],[Range.prototype,"surroundContents",first]].forEach(function(g){guard(g[0],g[1],g[2])});
[Element.prototype,Document.prototype,DocumentFragment.prototype].forEach(function(p){["append","prepend","replaceChildren"].forEach(function(k){guard(p,k,all)});guard(p,"moveBefore",first)});
[Element.prototype,CharacterData.prototype,DocumentType.prototype].forEach(function(p){["replaceWith","before","after"].forEach(function(k){guard(p,k,all)})});
["rel","href","as","imageSrcset","imageSizes"].forEach(function(k){var d=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,k);if(d)define(HTMLLinkElement.prototype,k,{get:d.get,set:function(){},configurable:false})});
var setA=Element.prototype.setAttribute,setANS=Element.prototype.setAttributeNS;
function inert(el,n){return bad(R(nameOf,el,[]))&&ATTRS[local(n)]===true}
fix(Element.prototype,"setAttribute",function(n,v){n=Str(n);if(inert(this,n))return;return R(setA,this,[n,v])});
fix(Element.prototype,"setAttributeNS",function(ns,n,v){n=Str(n);if(inert(this,n))return;return R(setANS,this,[ns,n,v])});
["XSLTProcessor"].forEach(function(k){fix(window,k,undefined)});
})();`;

/**
 * WebRTC taken away, first and on its own: it reaches the network beside
 * any policy (a STUN request carries what the page puts in it). And since a
 * frame is a fresh realm with its own RTCPeerConnection, no frame, object or
 * embed hands its window or document to the page either. Neither waits on
 * the guard.
 */
export const RTC_GUARD = `(function(){var d=Object.defineProperty;["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver"].forEach(function(k){try{d(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}});["HTMLIFrameElement","HTMLFrameElement","HTMLObjectElement"].forEach(function(c){var p=window[c]&&window[c].prototype;if(p)["contentWindow","contentDocument"].forEach(function(k){try{d(p,k,{get:function(){return null},configurable:false})}catch(e){}})})})();`;

/**
 * Text that holds no tags of the page's: a comment, and what a raw element
 * holds (a script, a style, a textarea, a title), as the HTML parser reads
 * them. A "<body>" in a script's string is not the page's body.
 */
const RAW = /<!--[\s\S]*?(?:-->|$)|(<(script|style|textarea|title|xmp|noscript)(?=[\s>/])[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi;

/** The page with that text blanked, at the same length, so a tag found in it is at the same place in the page. */
function masked(html: string): string {
  return html.replace(RAW, (whole: string, open: string | undefined, _tag: string | undefined, inner: string | undefined, close: string | undefined) =>
    open === undefined ? " ".repeat(whole.length) : `${open}${" ".repeat(inner!.length)}${close}`,
  );
}

/** A page's own head and body, from a whole document or a fragment; tags are looked for only where the parser would read them. */
export function splitHtml(html: string): { head: string; body: string } {
  // The doctype and the html tags go, from the page and its blanked copy alike, so the two stay aligned.
  let text = "";
  let blank = "";
  const plain = masked(html);
  let at = 0;
  for (const m of plain.matchAll(/<!doctype[^>]*>|<\/?html(?=[\s>/])[^>]*>/gi)) {
    text += html.slice(at, m.index);
    blank += plain.slice(at, m.index);
    at = m.index + m[0].length;
  }
  text += html.slice(at);
  blank += plain.slice(at);
  const head = /<head(?=[\s>/])[^>]*>([\s\S]*?)<\/head\s*>/i.exec(blank);
  // What a tag holds, cut from the page where the blanked copy found it: after the tag's own ">", for as long as it held.
  const inner = (from: string, m: RegExpExecArray): string => from.substr(m.index + m[0].indexOf(">") + 1, m[1]!.length);
  const headText = head ? inner(text, head) : "";
  const restText = head ? text.slice(0, head.index) + text.slice(head.index + head[0].length) : text;
  const restBlank = head ? blank.slice(0, head.index) + blank.slice(head.index + head[0].length) : blank;
  const body = /<body(?=[\s>/])[^>]*>([\s\S]*?)(<\/body\s*>|$)/i.exec(restBlank);
  return { head: headText, body: body ? inner(restText, body) : restText };
}

/** The tokens as one :root rule, for the page and for a change of theme. */
export function tokenRule(tokens: Record<string, string>, mode: "light" | "dark"): string {
  return `:root{--scheme:${mode};${Object.entries(tokens)
    .map(([name, value]) => `${name}:${value.replace(/[;{}<]/g, "")}`)
    .join(";")}}`;
}

/**
 * The page's side of window.kos. Calls go to the shell as messages and come
 * back as promises; a link to a place on the page (#id) scrolls there,
 * since in a srcdoc frame it would resolve against the dashboard's address
 * and send the frame away; the shell answers only this frame, and the server checks
 * each call against what the page declared. Errors the page throws are told
 * to the shell, which shows them with a way to ask KOS to fix the page.
 *
 * A page or a doc is as tall as its content: the bridge reports the height
 * (a ResizeObserver, debounced) and the shell sizes the frame, so the
 * dashboard scrolls as one page. With no scroll of its own, a jump to a
 * place on the page (a #id link, scrollIntoView) is reported with the same
 * message, as where the place is, and the shell scrolls the dashboard. The
 * frame keeps its own scrollbar only while it is shorter than its content,
 * as in the check's fixed view, past the shell's cap, or while the shell
 * holds a height; then a jump scrolls inside it too. While the frame is not
 * the height reported, the report is sent again, backing off, so a height
 * the shell set aside is asked for once the page settles.
 *
 * Before any of the page's own code runs, the bridge hands the shell a
 * channel of its own and tells it over that channel each time the owner
 * presses or types in the frame (trusted events only, caught first). The
 * page never holds the channel, so it cannot claim a press; the shell lets
 * a jump scroll the dashboard only just after one. A save is the shell's to
 * allow, not the page's: it is relayed while the owner's hand is in the
 * frame, or just after the shell's own Done.
 *
 * A page that paints a ground of its own (its body's background is not
 * KOS's --bg) is marked data-ground="own" on its root, now and on each theme
 * change (read once a background transition on either has settled, so a
 * colour caught mid-fade is never taken for one of its own), so the kit and
 * the runtimes give it back the gutter the dashboard's
 * column otherwise gives: its text never runs to the edge of its colour.
 *
 * Queries go out FRAME_QUERIES at a time, in the order asked; the rest wait
 * in the frame, so how many a page asks at once is never a refusal. One with
 * no answer in FRAME_QUERY_WAIT_MS gives its turn up and is refused.
 * How many of its calls are out (sent and not answered) or still queued is
 * kos.pending, read-only, kept in the bridge's own closure: an export waits
 * for it to reach 0, so a read the frame made but KOS has not heard yet is
 * not frozen as missing; kos.dropped, how many it gave up on unanswered,
 * tells an export that a read never reached KOS in time. A page can only
 * mislead its own export with either.
 */
export const BRIDGE_SCRIPT = `(function(){
var gestures=new MessageChannel(),gport=gestures.port1,tell=MessagePort.prototype.postMessage,apply=Reflect.apply,listen=EventTarget.prototype.addEventListener;
top.postMessage({__kos:"gestures"},"*",[gestures.port2]);
function stamp(e){if(e.isTrusted)apply(tell,gport,[0])}
apply(listen,window,["pointerdown",stamp,true]);apply(listen,window,["pointerup",stamp,true]);apply(listen,window,["keydown",stamp,true]);
var seq=0,waiting={},themeFns=[],refreshFns=[],mode=document.documentElement.dataset.mode||"dark";
var root=document.documentElement,fit=${JSON.stringify(FIT_KINDS)}.indexOf(root.dataset.kind||"page")>=0,last=-1,timer=0,retry=0,wait=500,into=Element.prototype.scrollIntoView;
function inner(){return root.scrollHeight>innerHeight+1}
function height(extra){var b=document.body,h=Math.ceil(Math.max(root.getBoundingClientRect().height,b?b.scrollHeight:0)),shown=Math.abs(h-innerHeight)<=1||(h>=${FRAME_HEIGHT_MAX}&&innerHeight>=${FRAME_HEIGHT_MAX}-1);root.style.overflowY=h<=innerHeight+1?"hidden":"";clearTimeout(retry);
if(shown)wait=500;else{retry=setTimeout(function(){height()},wait);wait=Math.min(wait*2,8000)}
if(!extra&&h===last&&shown)return;last=h;top.postMessage(Object.assign({__kos:"height",height:h},extra||{}),"*")}
function measure(){clearTimeout(timer);timer=setTimeout(function(){height()},60)}
function reveal(el,block){var r=el?el.getBoundingClientRect():{top:-scrollY,bottom:-scrollY};height({reveal:{top:Math.max(0,r.top+scrollY),bottom:Math.max(0,r.bottom+scrollY),block:block}})}
if(fit){
root.style.overflowX="hidden";
var watch=function(){var ro=new ResizeObserver(measure);ro.observe(root);if(document.body)ro.observe(document.body);height()};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch();
addEventListener("load",measure);
Element.prototype.scrollIntoView=function(o){if(inner())into.call(this,o);reveal(this,o===false?"end":o&&typeof o==="object"&&o.block||"start")};
}
var colourOf=${colourOf.toString()};
var grounded=0;
function ground(){var b=document.body,t=/--bg:([^;}]+)/.exec((document.getElementById("kos-tokens")||{}).textContent||"");if(!b||!t)return;
var moving=[b,root].reduce(function(all,n){return all.concat(n.getAnimations?n.getAnimations().filter(function(x){return x.playState==="running"&&!!x.effect&&x.effect.getComputedTiming().endTime!==Infinity}):[])},[]);
if(moving.length){Promise.all(moving.map(function(x){return x.finished.catch(function(){})})).then(reground);return}
var bs=getComputedStyle(b),hs=getComputedStyle(root),own=bs.backgroundImage!=="none"||hs.backgroundImage!=="none";
if(!own){var c=colourOf(bs.backgroundColor);if(!c||c[3]===0)c=colourOf(hs.backgroundColor);var k=colourOf(t[1].trim());own=!!c&&!!k&&c[3]>0&&Math.max(Math.abs(c[0]-k[0]),Math.abs(c[1]-k[1]),Math.abs(c[2]-k[2]))>2}
if(own)root.dataset.ground="own";else delete root.dataset.ground}
function reground(){cancelAnimationFrame(grounded);grounded=requestAnimationFrame(ground)}
function watchGround(){ground();var o={attributes:true,attributeFilter:["style","class"]};var mo=new MutationObserver(reground);mo.observe(root,o);if(document.body)mo.observe(document.body,o);var st=new MutationObserver(reground);st.observe(document.head,{childList:true,subtree:true,characterData:true});
["transitionend","transitioncancel"].forEach(function(t){document.addEventListener(t,function(e){if(e.target===root||e.target===document.body)reground()},true)})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watchGround);else watchGround();
addEventListener("load",ground);
function call(method,args,sent){return new Promise(function(resolve,reject){var id=++seq;if(sent)sent.id=id;waiting[id]={resolve:resolve,reject:reject};top.postMessage({__kos:"call",id:id,method:method,args:args},"*");});}
var asking=0,asks=[];
var dropped=0;
function send(a){var sent={},over=false,timer=setTimeout(function(){if(end()){dropped++;a.reject(new Error("the query had no answer in ${FRAME_QUERY_WAIT_MS / 1000} s; KOS may be busy, so try again"))}},${FRAME_QUERY_WAIT_MS});
function end(){if(over)return false;over=true;clearTimeout(timer);delete waiting[sent.id];asking--;ask();return true}
asking++;call("query",a.args,sent).then(function(r){if(end())a.resolve(r)},function(e){if(end())a.reject(e)})}
function ask(){while(asking<${FRAME_QUERIES}&&asks.length)send(asks.shift())}
function report(message){try{top.postMessage({__kos:"error",message:String(message).slice(0,2000)},"*");}catch(_){}}
addEventListener("message",function(e){
if(e.source!==top)return;var m=e.data||{};
if(m.__kos==="reply"){var w=waiting[m.id];if(!w)return;delete waiting[m.id];if(m.error)w.reject(new Error(m.error));else w.resolve(m.result);}
else if(m.__kos==="theme"){mode=m.mode;document.documentElement.dataset.mode=m.mode;document.documentElement.dataset.theme=m.mode;var s=document.getElementById("kos-tokens");if(s)s.textContent=m.rule;themeFns.forEach(function(f){try{f(m.mode)}catch(err){report(err&&err.message||err)}});ground();}
else if(m.__kos==="present"){var on=m.on===true;if(on)document.documentElement.dataset.present="on";else delete document.documentElement.dataset.present;dispatchEvent(new CustomEvent("kos:present",{detail:{on:on}}));}
});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href^='#']"):null;if(!a||e.defaultPrevented)return;e.preventDefault();var id=decodeURIComponent(a.getAttribute("href").slice(1)),t=id?document.getElementById(id):null,b=matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth";if(t)t.scrollIntoView({behavior:b,block:"start"});else if(!id){if(!fit||inner())scrollTo({top:0,behavior:b});if(fit)reveal(null,"start")}});
addEventListener("error",function(e){report(e.message||"The page hit an error")});
addEventListener("unhandledrejection",function(e){var r=e.reason;report(r&&r.message?r.message:String(r))});
var kos={
query:function(sql,params){return new Promise(function(resolve,reject){asks.push({args:{sql:sql,params:params},resolve:resolve,reject:reject});ask()})},
write:function(table,op,values,key){return call("write",{table:table,op:op,values:values,key:key}).then(function(r){refreshFns.forEach(function(f){try{f()}catch(err){report(err&&err.message||err)}});return r})},
writes:function(list){return call("write",{writes:list}).then(function(r){refreshFns.forEach(function(f){try{f()}catch(err){report(err&&err.message||err)}});return r})},
files:Object.freeze({read:function(path){return call("file",{path:path})}}),
ask:function(text){return call("ask",{text:String(text)})},
save:function(edit){return call("save",{edit:edit})},
mention:function(at){at=at||{};return call("mention",{x:Number(at.x),y:Number(at.y)})},
open:function(id){return call("open",{id:String(id)})},
present:function(on){top.postMessage({__kos:"present",on:on!==false},"*")},
onTheme:function(f){themeFns.push(f)},
refresh:function(f){refreshFns.push(f)}
};
Object.defineProperty(kos,"theme",{get:function(){return mode},enumerable:true});
Object.defineProperty(kos,"pending",{get:function(){return Object.keys(waiting).length+asks.length},enumerable:false});
Object.defineProperty(kos,"dropped",{get:function(){return dropped},enumerable:false});
Object.defineProperty(window,"kos",{value:Object.freeze(kos)});
})();`;

/** Keep a page's script from ending ours early or reading as markup. */
const scriptSafe = (code: string): string => code.replace(/<\/script/gi, "<\\/script");

export interface PageDocumentInput {
  html: string;
  tokens: Record<string, string>;
  mode: "light" | "dark";
  /** The kit's stylesheets, then the fonts' faces and stacks: plain CSS, no markup. */
  css: string;
  /** The text of each library the page named, and its kind's runtime, already fetched. */
  libraries: string[];
  /** The artifact's kind, which its runtime and its own CSS can key on. */
  kind?: string;
  /** An older version shown to look at: the runtimes offer no editing. */
  locked?: boolean;
}

export function pageDocument({ html, tokens, mode, css, libraries, kind = "page", locked = false }: PageDocumentInput): string {
  const { head, body } = splitHtml(html);
  return [
    "<!doctype html>",
    `<html data-mode="${mode}" data-theme="${mode}" data-kind="${kind.replace(/[^a-z]/g, "")}"${locked ? " data-locked" : ""}><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_GUARD_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<script>${RTC_GUARD}</script>`,
    `<script>${GUARD_SCRIPT}</script>`,
    `<style id="kos-tokens">${tokenRule(tokens, mode)}</style>`,
    `<style>${css.replace(/<\/style/gi, "")}</style>`,
    `<script>${BRIDGE_SCRIPT}</script>`,
    ...libraries.map((code) => `<script>${scriptSafe(code)}</script>`),
    head,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The wrapper the dashboard frames: the page's frame and nothing else, under a
 * policy that lets that frame hold about: documents only. Its one script tells
 * the dashboard when the page's frame loads a second time, which is the page
 * having tried to leave.
 */
export function wrapperDocument(page: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`,
    "<style>html,body{margin:0;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>",
    "</head><body>",
    `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attr(page)}"></iframe>`,
    '<script>(function(){var f=document.querySelector("iframe"),n=0;f.addEventListener("load",function(){if(++n>1)top.postMessage({__kos:"left"},"*")})})()</script>',
    "</body></html>",
  ].join("");
}
