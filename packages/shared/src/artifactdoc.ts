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
 *    policy, which refuses their markup, prefixed or not;
 *  - the factories (createElement, createElementNS, createDocument) refuse
 *    them by name;
 *  - and since a parser can still make one (an XML document's entities, a
 *    document made elsewhere), nothing holding one may be adopted, imported
 *    or put into a document, by any of the methods that place a node.
 *
 * A <link> that exists anyway takes no rel or href. WebRTC, which reaches
 * the network beside the policy, and XSLT, which builds elements from data,
 * are taken away. Every replacement is fixed in place, and what it checks
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
trustedTypes.createPolicy("default",{createHTML:function(s){if(R(exec,inMarkup,[s])!==null||R(exec,inXsl,[s])!==null)refuse("that markup");return s},createScript:function(){refuse("a script")},createScriptURL:function(){refuse("a script URL")}});
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
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","XSLTProcessor"].forEach(function(k){fix(window,k,undefined)});
})();`;

/** A page's own head and body, from a whole document or a fragment. */
export function splitHtml(html: string): { head: string; body: string } {
  const text = html.replace(/<!doctype[^>]*>/i, "").replace(/<\/?html[^>]*>/gi, "");
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(text);
  const rest = head ? text.slice(0, head.index) + text.slice(head.index + head[0].length) : text;
  const body = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(rest);
  return { head: head?.[1] ?? "", body: body ? body[1]! : rest };
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
 */
export const BRIDGE_SCRIPT = `(function(){
var seq=0,waiting={},themeFns=[],refreshFns=[],mode=document.documentElement.dataset.mode||"dark";
function call(method,args){return new Promise(function(resolve,reject){var id=++seq;waiting[id]={resolve:resolve,reject:reject};top.postMessage({__kos:"call",id:id,method:method,args:args},"*");});}
function report(message){try{top.postMessage({__kos:"error",message:String(message).slice(0,2000)},"*");}catch(_){}}
addEventListener("message",function(e){
if(e.source!==top)return;var m=e.data||{};
if(m.__kos==="reply"){var w=waiting[m.id];if(!w)return;delete waiting[m.id];if(m.error)w.reject(new Error(m.error));else w.resolve(m.result);}
else if(m.__kos==="theme"){mode=m.mode;document.documentElement.dataset.mode=m.mode;document.documentElement.dataset.theme=m.mode;var s=document.getElementById("kos-tokens");if(s)s.textContent=m.rule;themeFns.forEach(function(f){try{f(m.mode)}catch(err){report(err&&err.message||err)}});}
else if(m.__kos==="present"){var on=m.on===true;if(on)document.documentElement.dataset.present="on";else delete document.documentElement.dataset.present;dispatchEvent(new CustomEvent("kos:present",{detail:{on:on}}));}
});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href^='#']"):null;if(!a||e.defaultPrevented)return;e.preventDefault();var id=decodeURIComponent(a.getAttribute("href").slice(1)),t=id?document.getElementById(id):null,b=matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth";if(t)t.scrollIntoView({behavior:b,block:"start"});else if(!id)scrollTo({top:0,behavior:b})});
addEventListener("error",function(e){report(e.message||"The page hit an error")});
addEventListener("unhandledrejection",function(e){var r=e.reason;report(r&&r.message?r.message:String(r))});
var kos={
query:function(sql,params){return call("query",{sql:sql,params:params})},
write:function(table,op,values,key){return call("write",{table:table,op:op,values:values,key:key}).then(function(r){refreshFns.forEach(function(f){try{f()}catch(err){report(err&&err.message||err)}});return r})},
files:Object.freeze({read:function(path){return call("file",{path:path})}}),
ask:function(text){return call("ask",{text:String(text)})},
save:function(edit){var u=navigator.userActivation;if(u&&!u.isActive)return Promise.reject(new Error("a save comes from the owner: press Save, or edit a cell"));return call("save",{edit:edit})},
present:function(){top.postMessage({__kos:"present"},"*")},
onTheme:function(f){themeFns.push(f)},
refresh:function(f){refreshFns.push(f)}
};
Object.defineProperty(kos,"theme",{get:function(){return mode},enumerable:true});
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
}

export function pageDocument({ html, tokens, mode, css, libraries, kind = "page" }: PageDocumentInput): string {
  const { head, body } = splitHtml(html);
  return [
    "<!doctype html>",
    `<html data-mode="${mode}" data-theme="${mode}" data-kind="${kind.replace(/[^a-z]/g, "")}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_GUARD_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
