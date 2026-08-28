import{c as p,e as uo,g as C,h as s,i as _,j as h,k as D,l as Tn,n as d}from"./chunk-HDN7WHJK.mjs";var Va=p((LE,ka)=>{d();ka.exports=function(){return typeof Promise=="function"&&Promise.prototype&&Promise.prototype.then}});var ae=p(Oe=>{d();var Bn,ru=[0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706];Oe.getSymbolSize=function(e){if(!e)throw new Error('"version" cannot be null or undefined');if(e<1||e>40)throw new Error('"version" should be in range from 1 to 40');return e*4+17};Oe.getSymbolTotalCodewords=function(e){return ru[e]};Oe.getBCHDigit=function(t){let e=0;for(;t!==0;)e++,t>>>=1;return e};Oe.setToSJISFunction=function(e){if(typeof e!="function")throw new Error('"toSJISFunc" is not a valid function.');Bn=e};Oe.isKanjiModeEnabled=function(){return typeof Bn<"u"};Oe.toSJIS=function(e){return Bn(e)}});var kt=p(K=>{d();K.L={bit:1};K.M={bit:0};K.Q={bit:3};K.H={bit:2};function ou(t){if(typeof t!="string")throw new Error("Param is not a string");switch(t.toLowerCase()){case"l":case"low":return K.L;case"m":case"medium":return K.M;case"q":case"quartile":return K.Q;case"h":case"high":return K.H;default:throw new Error("Unknown EC Level: "+t)}}K.isValid=function(e){return e&&typeof e.bit<"u"&&e.bit>=0&&e.bit<4};K.from=function(e,n){if(K.isValid(e))return e;try{return ou(e)}catch{return n}}});var Ha=p((ME,za)=>{d();function Ga(){this.buffer=[],this.length=0}Ga.prototype={get:function(t){let e=Math.floor(t/8);return(this.buffer[e]>>>7-t%8&1)===1},put:function(t,e){for(let n=0;n<e;n++)this.putBit((t>>>e-n-1&1)===1)},getLengthInBits:function(){return this.length},putBit:function(t){let e=Math.floor(this.length/8);this.buffer.length<=e&&this.buffer.push(0),t&&(this.buffer[e]|=128>>>this.length%8),this.length++}};za.exports=Ga});var Wa=p((PE,Ka)=>{d();function Xe(t){if(!t||t<1)throw new Error("BitMatrix size must be defined and greater than 0");this.size=t,this.data=new Uint8Array(t*t),this.reservedBit=new Uint8Array(t*t)}Xe.prototype.set=function(t,e,n,a){let r=t*this.size+e;this.data[r]=n,a&&(this.reservedBit[r]=!0)};Xe.prototype.get=function(t,e){return this.data[t*this.size+e]};Xe.prototype.xor=function(t,e,n){this.data[t*this.size+e]^=n};Xe.prototype.isReserved=function(t,e){return this.reservedBit[t*this.size+e]};Ka.exports=Xe});var qa=p(Vt=>{d();var iu=ae().getSymbolSize;Vt.getRowColCoords=function(e){if(e===1)return[];let n=Math.floor(e/7)+2,a=iu(e),r=a===145?26:Math.ceil((a-13)/(2*n-2))*2,o=[a-7];for(let i=1;i<n-1;i++)o[i]=o[i-1]-r;return o.push(6),o.reverse()};Vt.getPositions=function(e){let n=[],a=Vt.getRowColCoords(e),r=a.length;for(let o=0;o<r;o++)for(let i=0;i<r;i++)o===0&&i===0||o===0&&i===r-1||o===r-1&&i===0||n.push([a[o],a[i]]);return n}});var ja=p(Xa=>{d();var su=ae().getSymbolSize,Ya=7;Xa.getPositions=function(e){let n=su(e);return[[0,0],[n-Ya,0],[0,n-Ya]]}});var Ja=p(I=>{d();I.Patterns={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};var Ne={N1:3,N2:3,N3:40,N4:10};I.isValid=function(e){return e!=null&&e!==""&&!isNaN(e)&&e>=0&&e<=7};I.from=function(e){return I.isValid(e)?parseInt(e,10):void 0};I.getPenaltyN1=function(e){let n=e.size,a=0,r=0,o=0,i=null,c=null;for(let l=0;l<n;l++){r=o=0,i=c=null;for(let u=0;u<n;u++){let R=e.get(l,u);R===i?r++:(r>=5&&(a+=Ne.N1+(r-5)),i=R,r=1),R=e.get(u,l),R===c?o++:(o>=5&&(a+=Ne.N1+(o-5)),c=R,o=1)}r>=5&&(a+=Ne.N1+(r-5)),o>=5&&(a+=Ne.N1+(o-5))}return a};I.getPenaltyN2=function(e){let n=e.size,a=0;for(let r=0;r<n-1;r++)for(let o=0;o<n-1;o++){let i=e.get(r,o)+e.get(r,o+1)+e.get(r+1,o)+e.get(r+1,o+1);(i===4||i===0)&&a++}return a*Ne.N2};I.getPenaltyN3=function(e){let n=e.size,a=0,r=0,o=0;for(let i=0;i<n;i++){r=o=0;for(let c=0;c<n;c++)r=r<<1&2047|e.get(i,c),c>=10&&(r===1488||r===93)&&a++,o=o<<1&2047|e.get(c,i),c>=10&&(o===1488||o===93)&&a++}return a*Ne.N3};I.getPenaltyN4=function(e){let n=0,a=e.data.length;for(let o=0;o<a;o++)n+=e.data[o];return Math.abs(Math.ceil(n*100/a/5)-10)*Ne.N4};function cu(t,e,n){switch(t){case I.Patterns.PATTERN000:return(e+n)%2===0;case I.Patterns.PATTERN001:return e%2===0;case I.Patterns.PATTERN010:return n%3===0;case I.Patterns.PATTERN011:return(e+n)%3===0;case I.Patterns.PATTERN100:return(Math.floor(e/2)+Math.floor(n/3))%2===0;case I.Patterns.PATTERN101:return e*n%2+e*n%3===0;case I.Patterns.PATTERN110:return(e*n%2+e*n%3)%2===0;case I.Patterns.PATTERN111:return(e*n%3+(e+n)%2)%2===0;default:throw new Error("bad maskPattern:"+t)}}I.applyMask=function(e,n){let a=n.size;for(let r=0;r<a;r++)for(let o=0;o<a;o++)n.isReserved(o,r)||n.xor(o,r,cu(e,o,r))};I.getBestMask=function(e,n){let a=Object.keys(I.Patterns).length,r=0,o=1/0;for(let i=0;i<a;i++){n(i),I.applyMask(i,e);let c=I.getPenaltyN1(e)+I.getPenaltyN2(e)+I.getPenaltyN3(e)+I.getPenaltyN4(e);I.applyMask(i,e),c<o&&(o=c,r=i)}return r}});var $n=p(Fn=>{d();var re=kt(),Gt=[1,1,1,1,1,1,1,1,1,1,2,2,1,2,2,4,1,2,4,4,2,4,4,4,2,4,6,5,2,4,6,6,2,5,8,8,4,5,8,8,4,5,8,11,4,8,10,11,4,9,12,16,4,9,16,16,6,10,12,18,6,10,17,16,6,11,16,19,6,13,18,21,7,14,21,25,8,16,20,25,8,17,23,25,9,17,23,34,9,18,25,30,10,20,27,32,12,21,29,35,12,23,34,37,12,25,34,40,13,26,35,42,14,28,38,45,15,29,40,48,16,31,43,51,17,33,45,54,18,35,48,57,19,37,51,60,19,38,53,63,20,40,56,66,21,43,59,70,22,45,62,74,24,47,65,77,25,49,68,81],zt=[7,10,13,17,10,16,22,28,15,26,36,44,20,36,52,64,26,48,72,88,36,64,96,112,40,72,108,130,48,88,132,156,60,110,160,192,72,130,192,224,80,150,224,264,96,176,260,308,104,198,288,352,120,216,320,384,132,240,360,432,144,280,408,480,168,308,448,532,180,338,504,588,196,364,546,650,224,416,600,700,224,442,644,750,252,476,690,816,270,504,750,900,300,560,810,960,312,588,870,1050,336,644,952,1110,360,700,1020,1200,390,728,1050,1260,420,784,1140,1350,450,812,1200,1440,480,868,1290,1530,510,924,1350,1620,540,980,1440,1710,570,1036,1530,1800,570,1064,1590,1890,600,1120,1680,1980,630,1204,1770,2100,660,1260,1860,2220,720,1316,1950,2310,750,1372,2040,2430];Fn.getBlocksCount=function(e,n){switch(n){case re.L:return Gt[(e-1)*4+0];case re.M:return Gt[(e-1)*4+1];case re.Q:return Gt[(e-1)*4+2];case re.H:return Gt[(e-1)*4+3];default:return}};Fn.getTotalCodewordsCount=function(e,n){switch(n){case re.L:return zt[(e-1)*4+0];case re.M:return zt[(e-1)*4+1];case re.Q:return zt[(e-1)*4+2];case re.H:return zt[(e-1)*4+3];default:return}}});var Za=p(Kt=>{d();var je=new Uint8Array(512),Ht=new Uint8Array(256);(function(){let e=1;for(let n=0;n<255;n++)je[n]=e,Ht[e]=n,e<<=1,e&256&&(e^=285);for(let n=255;n<512;n++)je[n]=je[n-255]})();Kt.log=function(e){if(e<1)throw new Error("log("+e+")");return Ht[e]};Kt.exp=function(e){return je[e]};Kt.mul=function(e,n){return e===0||n===0?0:je[Ht[e]+Ht[n]]}});var Qa=p(Je=>{d();var kn=Za();Je.mul=function(e,n){let a=new Uint8Array(e.length+n.length-1);for(let r=0;r<e.length;r++)for(let o=0;o<n.length;o++)a[r+o]^=kn.mul(e[r],n[o]);return a};Je.mod=function(e,n){let a=new Uint8Array(e);for(;a.length-n.length>=0;){let r=a[0];for(let i=0;i<n.length;i++)a[i]^=kn.mul(n[i],r);let o=0;for(;o<a.length&&a[o]===0;)o++;a=a.slice(o)}return a};Je.generateECPolynomial=function(e){let n=new Uint8Array([1]);for(let a=0;a<e;a++)n=Je.mul(n,new Uint8Array([1,kn.exp(a)]));return n}});var nr=p((jE,tr)=>{d();var er=Qa();function Vn(t){this.genPoly=void 0,this.degree=t,this.degree&&this.initialize(this.degree)}Vn.prototype.initialize=function(e){this.degree=e,this.genPoly=er.generateECPolynomial(this.degree)};Vn.prototype.encode=function(e){if(!this.genPoly)throw new Error("Encoder not initialized");let n=new Uint8Array(e.length+this.degree);n.set(e);let a=er.mod(n,this.genPoly),r=this.degree-a.length;if(r>0){let o=new Uint8Array(this.degree);return o.set(a,r),o}return a};tr.exports=Vn});var Gn=p(ar=>{d();ar.isValid=function(e){return!isNaN(e)&&e>=1&&e<=40}});var zn=p(j=>{d();var rr="[0-9]+",lu="[A-Z $%*+\\-./:]+",Ze="(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";Ze=Ze.replace(/u/g,"\\u");var du="(?:(?![A-Z0-9 $%*+\\-./:]|"+Ze+`)(?:.|[\r
]))+`;j.KANJI=new RegExp(Ze,"g");j.BYTE_KANJI=new RegExp("[^A-Z0-9 $%*+\\-./:]+","g");j.BYTE=new RegExp(du,"g");j.NUMERIC=new RegExp(rr,"g");j.ALPHANUMERIC=new RegExp(lu,"g");var _u=new RegExp("^"+Ze+"$"),uu=new RegExp("^"+rr+"$"),Ru=new RegExp("^[A-Z0-9 $%*+\\-./:]+$");j.testKanji=function(e){return _u.test(e)};j.testNumeric=function(e){return uu.test(e)};j.testAlphanumeric=function(e){return Ru.test(e)}});var oe=p(b=>{d();var Eu=Gn(),Hn=zn();b.NUMERIC={id:"Numeric",bit:1,ccBits:[10,12,14]};b.ALPHANUMERIC={id:"Alphanumeric",bit:2,ccBits:[9,11,13]};b.BYTE={id:"Byte",bit:4,ccBits:[8,16,16]};b.KANJI={id:"Kanji",bit:8,ccBits:[8,10,12]};b.MIXED={bit:-1};b.getCharCountIndicator=function(e,n){if(!e.ccBits)throw new Error("Invalid mode: "+e);if(!Eu.isValid(n))throw new Error("Invalid version: "+n);return n>=1&&n<10?e.ccBits[0]:n<27?e.ccBits[1]:e.ccBits[2]};b.getBestModeForData=function(e){return Hn.testNumeric(e)?b.NUMERIC:Hn.testAlphanumeric(e)?b.ALPHANUMERIC:Hn.testKanji(e)?b.KANJI:b.BYTE};b.toString=function(e){if(e&&e.id)return e.id;throw new Error("Invalid mode")};b.isValid=function(e){return e&&e.bit&&e.ccBits};function hu(t){if(typeof t!="string")throw new Error("Param is not a string");switch(t.toLowerCase()){case"numeric":return b.NUMERIC;case"alphanumeric":return b.ALPHANUMERIC;case"kanji":return b.KANJI;case"byte":return b.BYTE;default:throw new Error("Unknown mode: "+t)}}b.from=function(e,n){if(b.isValid(e))return e;try{return hu(e)}catch{return n}}});var lr=p(Se=>{d();var Wt=ae(),Au=$n(),or=kt(),ie=oe(),Kn=Gn(),sr=7973,ir=Wt.getBCHDigit(sr);function Ou(t,e,n){for(let a=1;a<=40;a++)if(e<=Se.getCapacity(a,n,t))return a}function cr(t,e){return ie.getCharCountIndicator(t,e)+4}function Nu(t,e){let n=0;return t.forEach(function(a){let r=cr(a.mode,e);n+=r+a.getBitsLength()}),n}function Su(t,e){for(let n=1;n<=40;n++)if(Nu(t,n)<=Se.getCapacity(n,e,ie.MIXED))return n}Se.from=function(e,n){return Kn.isValid(e)?parseInt(e,10):n};Se.getCapacity=function(e,n,a){if(!Kn.isValid(e))throw new Error("Invalid QR Code version");typeof a>"u"&&(a=ie.BYTE);let r=Wt.getSymbolTotalCodewords(e),o=Au.getTotalCodewordsCount(e,n),i=(r-o)*8;if(a===ie.MIXED)return i;let c=i-cr(a,e);switch(a){case ie.NUMERIC:return Math.floor(c/10*3);case ie.ALPHANUMERIC:return Math.floor(c/11*2);case ie.KANJI:return Math.floor(c/13);case ie.BYTE:default:return Math.floor(c/8)}};Se.getBestVersionForData=function(e,n){let a,r=or.from(n,or.M);if(Array.isArray(e)){if(e.length>1)return Su(e,r);if(e.length===0)return 1;a=e[0]}else a=e;return Ou(a.mode,a.getLength(),r)};Se.getEncodedBits=function(e){if(!Kn.isValid(e)||e<7)throw new Error("Invalid QR Code version");let n=e<<12;for(;Wt.getBCHDigit(n)-ir>=0;)n^=sr<<Wt.getBCHDigit(n)-ir;return e<<12|n}});var Rr=p(ur=>{d();var Wn=ae(),_r=1335,mu=21522,dr=Wn.getBCHDigit(_r);ur.getEncodedBits=function(e,n){let a=e.bit<<3|n,r=a<<10;for(;Wn.getBCHDigit(r)-dr>=0;)r^=_r<<Wn.getBCHDigit(r)-dr;return(a<<10|r)^mu}});var hr=p((c0,Er)=>{d();var pu=oe();function Le(t){this.mode=pu.NUMERIC,this.data=t.toString()}Le.getBitsLength=function(e){return 10*Math.floor(e/3)+(e%3?e%3*3+1:0)};Le.prototype.getLength=function(){return this.data.length};Le.prototype.getBitsLength=function(){return Le.getBitsLength(this.data.length)};Le.prototype.write=function(e){let n,a,r;for(n=0;n+3<=this.data.length;n+=3)a=this.data.substr(n,3),r=parseInt(a,10),e.put(r,10);let o=this.data.length-n;o>0&&(a=this.data.substr(n),r=parseInt(a,10),e.put(r,o*3+1))};Er.exports=Le});var Or=p((d0,Ar)=>{d();var gu=oe(),qn=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"," ","$","%","*","+","-",".","/",":"];function be(t){this.mode=gu.ALPHANUMERIC,this.data=t}be.getBitsLength=function(e){return 11*Math.floor(e/2)+6*(e%2)};be.prototype.getLength=function(){return this.data.length};be.prototype.getBitsLength=function(){return be.getBitsLength(this.data.length)};be.prototype.write=function(e){let n;for(n=0;n+2<=this.data.length;n+=2){let a=qn.indexOf(this.data[n])*45;a+=qn.indexOf(this.data[n+1]),e.put(a,11)}this.data.length%2&&e.put(qn.indexOf(this.data[n]),6)};Ar.exports=be});var Sr=p((u0,Nr)=>{d();var fu=oe();function ye(t){this.mode=fu.BYTE,typeof t=="string"?this.data=new TextEncoder().encode(t):this.data=new Uint8Array(t)}ye.getBitsLength=function(e){return e*8};ye.prototype.getLength=function(){return this.data.length};ye.prototype.getBitsLength=function(){return ye.getBitsLength(this.data.length)};ye.prototype.write=function(t){for(let e=0,n=this.data.length;e<n;e++)t.put(this.data[e],8)};Nr.exports=ye});var pr=p((E0,mr)=>{d();var Tu=oe(),Iu=ae();function ve(t){this.mode=Tu.KANJI,this.data=t}ve.getBitsLength=function(e){return e*13};ve.prototype.getLength=function(){return this.data.length};ve.prototype.getBitsLength=function(){return ve.getBitsLength(this.data.length)};ve.prototype.write=function(t){let e;for(e=0;e<this.data.length;e++){let n=Iu.toSJIS(this.data[e]);if(n>=33088&&n<=40956)n-=33088;else if(n>=57408&&n<=60351)n-=49472;else throw new Error("Invalid SJIS character: "+this.data[e]+`
Make sure your charset is UTF-8`);n=(n>>>8&255)*192+(n&255),t.put(n,13)}};mr.exports=ve});var gr=p((A0,Yn)=>{"use strict";d();var Qe={single_source_shortest_paths:function(t,e,n){var a={},r={};r[e]=0;var o=Qe.PriorityQueue.make();o.push(e,0);for(var i,c,l,u,R,f,S,v,k;!o.empty();){i=o.pop(),c=i.value,u=i.cost,R=t[c]||{};for(l in R)R.hasOwnProperty(l)&&(f=R[l],S=u+f,v=r[l],k=typeof r[l]>"u",(k||v>S)&&(r[l]=S,o.push(l,S),a[l]=c))}if(typeof n<"u"&&typeof r[n]>"u"){var w=["Could not find a path from ",e," to ",n,"."].join("");throw new Error(w)}return a},extract_shortest_path_from_predecessor_list:function(t,e){for(var n=[],a=e,r;a;)n.push(a),r=t[a],a=t[a];return n.reverse(),n},find_path:function(t,e,n){var a=Qe.single_source_shortest_paths(t,e,n);return Qe.extract_shortest_path_from_predecessor_list(a,n)},PriorityQueue:{make:function(t){var e=Qe.PriorityQueue,n={},a;t=t||{};for(a in e)e.hasOwnProperty(a)&&(n[a]=e[a]);return n.queue=[],n.sorter=t.sorter||e.default_sorter,n},default_sorter:function(t,e){return t.cost-e.cost},push:function(t,e){var n={value:t,cost:e};this.queue.push(n),this.queue.sort(this.sorter)},pop:function(){return this.queue.shift()},empty:function(){return this.queue.length===0}}};typeof Yn<"u"&&(Yn.exports=Qe)});var yr=p(De=>{d();var m=oe(),Ir=hr(),Cr=Or(),wr=Sr(),Lr=pr(),et=zn(),qt=ae(),Cu=gr();function fr(t){return unescape(encodeURIComponent(t)).length}function tt(t,e,n){let a=[],r;for(;(r=t.exec(n))!==null;)a.push({data:r[0],index:r.index,mode:e,length:r[0].length});return a}function br(t){let e=tt(et.NUMERIC,m.NUMERIC,t),n=tt(et.ALPHANUMERIC,m.ALPHANUMERIC,t),a,r;return qt.isKanjiModeEnabled()?(a=tt(et.BYTE,m.BYTE,t),r=tt(et.KANJI,m.KANJI,t)):(a=tt(et.BYTE_KANJI,m.BYTE,t),r=[]),e.concat(n,a,r).sort(function(i,c){return i.index-c.index}).map(function(i){return{data:i.data,mode:i.mode,length:i.length}})}function Xn(t,e){switch(e){case m.NUMERIC:return Ir.getBitsLength(t);case m.ALPHANUMERIC:return Cr.getBitsLength(t);case m.KANJI:return Lr.getBitsLength(t);case m.BYTE:return wr.getBitsLength(t)}}function wu(t){return t.reduce(function(e,n){let a=e.length-1>=0?e[e.length-1]:null;return a&&a.mode===n.mode?(e[e.length-1].data+=n.data,e):(e.push(n),e)},[])}function Lu(t){let e=[];for(let n=0;n<t.length;n++){let a=t[n];switch(a.mode){case m.NUMERIC:e.push([a,{data:a.data,mode:m.ALPHANUMERIC,length:a.length},{data:a.data,mode:m.BYTE,length:a.length}]);break;case m.ALPHANUMERIC:e.push([a,{data:a.data,mode:m.BYTE,length:a.length}]);break;case m.KANJI:e.push([a,{data:a.data,mode:m.BYTE,length:fr(a.data)}]);break;case m.BYTE:e.push([{data:a.data,mode:m.BYTE,length:fr(a.data)}])}}return e}function bu(t,e){let n={},a={start:{}},r=["start"];for(let o=0;o<t.length;o++){let i=t[o],c=[];for(let l=0;l<i.length;l++){let u=i[l],R=""+o+l;c.push(R),n[R]={node:u,lastCount:0},a[R]={};for(let f=0;f<r.length;f++){let S=r[f];n[S]&&n[S].node.mode===u.mode?(a[S][R]=Xn(n[S].lastCount+u.length,u.mode)-Xn(n[S].lastCount,u.mode),n[S].lastCount+=u.length):(n[S]&&(n[S].lastCount=u.length),a[S][R]=Xn(u.length,u.mode)+4+m.getCharCountIndicator(u.mode,e))}}r=c}for(let o=0;o<r.length;o++)a[r[o]].end=0;return{map:a,table:n}}function Tr(t,e){let n,a=m.getBestModeForData(t);if(n=m.from(e,a),n!==m.BYTE&&n.bit<a.bit)throw new Error('"'+t+'" cannot be encoded with mode '+m.toString(n)+`.
 Suggested mode is: `+m.toString(a));switch(n===m.KANJI&&!qt.isKanjiModeEnabled()&&(n=m.BYTE),n){case m.NUMERIC:return new Ir(t);case m.ALPHANUMERIC:return new Cr(t);case m.KANJI:return new Lr(t);case m.BYTE:return new wr(t)}}De.fromArray=function(e){return e.reduce(function(n,a){return typeof a=="string"?n.push(Tr(a,null)):a.data&&n.push(Tr(a.data,a.mode)),n},[])};De.fromString=function(e,n){let a=br(e,qt.isKanjiModeEnabled()),r=Lu(a),o=bu(r,n),i=Cu.find_path(o.map,"start","end"),c=[];for(let l=1;l<i.length-1;l++)c.push(o.table[i[l]].node);return De.fromArray(wu(c))};De.rawSplit=function(e){return De.fromArray(br(e,qt.isKanjiModeEnabled()))}});var Dr=p(vr=>{d();var Xt=ae(),jn=kt(),yu=Ha(),vu=Wa(),Du=qa(),xu=ja(),Qn=Ja(),ea=$n(),Mu=nr(),Yt=lr(),Uu=Rr(),Pu=oe(),Jn=yr();function Bu(t,e){let n=t.size,a=xu.getPositions(e);for(let r=0;r<a.length;r++){let o=a[r][0],i=a[r][1];for(let c=-1;c<=7;c++)if(!(o+c<=-1||n<=o+c))for(let l=-1;l<=7;l++)i+l<=-1||n<=i+l||(c>=0&&c<=6&&(l===0||l===6)||l>=0&&l<=6&&(c===0||c===6)||c>=2&&c<=4&&l>=2&&l<=4?t.set(o+c,i+l,!0,!0):t.set(o+c,i+l,!1,!0))}}function Fu(t){let e=t.size;for(let n=8;n<e-8;n++){let a=n%2===0;t.set(n,6,a,!0),t.set(6,n,a,!0)}}function $u(t,e){let n=Du.getPositions(e);for(let a=0;a<n.length;a++){let r=n[a][0],o=n[a][1];for(let i=-2;i<=2;i++)for(let c=-2;c<=2;c++)i===-2||i===2||c===-2||c===2||i===0&&c===0?t.set(r+i,o+c,!0,!0):t.set(r+i,o+c,!1,!0)}}function ku(t,e){let n=t.size,a=Yt.getEncodedBits(e),r,o,i;for(let c=0;c<18;c++)r=Math.floor(c/3),o=c%3+n-8-3,i=(a>>c&1)===1,t.set(r,o,i,!0),t.set(o,r,i,!0)}function Zn(t,e,n){let a=t.size,r=Uu.getEncodedBits(e,n),o,i;for(o=0;o<15;o++)i=(r>>o&1)===1,o<6?t.set(o,8,i,!0):o<8?t.set(o+1,8,i,!0):t.set(a-15+o,8,i,!0),o<8?t.set(8,a-o-1,i,!0):o<9?t.set(8,15-o-1+1,i,!0):t.set(8,15-o-1,i,!0);t.set(a-8,8,1,!0)}function Vu(t,e){let n=t.size,a=-1,r=n-1,o=7,i=0;for(let c=n-1;c>0;c-=2)for(c===6&&c--;;){for(let l=0;l<2;l++)if(!t.isReserved(r,c-l)){let u=!1;i<e.length&&(u=(e[i]>>>o&1)===1),t.set(r,c-l,u),o--,o===-1&&(i++,o=7)}if(r+=a,r<0||n<=r){r-=a,a=-a;break}}}function Gu(t,e,n){let a=new yu;n.forEach(function(l){a.put(l.mode.bit,4),a.put(l.getLength(),Pu.getCharCountIndicator(l.mode,t)),l.write(a)});let r=Xt.getSymbolTotalCodewords(t),o=ea.getTotalCodewordsCount(t,e),i=(r-o)*8;for(a.getLengthInBits()+4<=i&&a.put(0,4);a.getLengthInBits()%8!==0;)a.putBit(0);let c=(i-a.getLengthInBits())/8;for(let l=0;l<c;l++)a.put(l%2?17:236,8);return zu(a,t,e)}function zu(t,e,n){let a=Xt.getSymbolTotalCodewords(e),r=ea.getTotalCodewordsCount(e,n),o=a-r,i=ea.getBlocksCount(e,n),c=a%i,l=i-c,u=Math.floor(a/i),R=Math.floor(o/i),f=R+1,S=u-R,v=new Mu(S),k=0,w=new Array(i),$=new Array(i),M=0,G=new Uint8Array(t.buffer);for(let N=0;N<i;N++){let L=N<l?R:f;w[N]=G.slice(k,k+L),$[N]=v.encode(w[N]),k+=L,M=Math.max(M,L)}let q=new Uint8Array(a),V=0,A,O;for(A=0;A<M;A++)for(O=0;O<i;O++)A<w[O].length&&(q[V++]=w[O][A]);for(A=0;A<S;A++)for(O=0;O<i;O++)q[V++]=$[O][A];return q}function Hu(t,e,n,a){let r;if(Array.isArray(t))r=Jn.fromArray(t);else if(typeof t=="string"){let u=e;if(!u){let R=Jn.rawSplit(t);u=Yt.getBestVersionForData(R,n)}r=Jn.fromString(t,u||40)}else throw new Error("Invalid data");let o=Yt.getBestVersionForData(r,n);if(!o)throw new Error("The amount of data is too big to be stored in a QR Code");if(!e)e=o;else if(e<o)throw new Error(`
The chosen QR Code version cannot contain this amount of data.
Minimum version required to store current data is: `+o+`.
`);let i=Gu(e,n,r),c=Xt.getSymbolSize(e),l=new vu(c);return Bu(l,e),Fu(l),$u(l,e),Zn(l,n,0),e>=7&&ku(l,e),Vu(l,i),isNaN(a)&&(a=Qn.getBestMask(l,Zn.bind(null,l,n))),Qn.applyMask(a,l),Zn(l,n,a),{modules:l,version:e,errorCorrectionLevel:n,maskPattern:a,segments:r}}vr.create=function(e,n){if(typeof e>"u"||e==="")throw new Error("No input text");let a=jn.M,r,o;return typeof n<"u"&&(a=jn.from(n.errorCorrectionLevel,jn.M),r=Yt.from(n.version),o=Qn.from(n.maskPattern),n.toSJISFunc&&Xt.setToSJISFunction(n.toSJISFunc)),Hu(e,r,a,o)}});var ta=p(me=>{d();function xr(t){if(typeof t=="number"&&(t=t.toString()),typeof t!="string")throw new Error("Color should be defined as hex string");let e=t.slice().replace("#","").split("");if(e.length<3||e.length===5||e.length>8)throw new Error("Invalid hex color: "+t);(e.length===3||e.length===4)&&(e=Array.prototype.concat.apply([],e.map(function(a){return[a,a]}))),e.length===6&&e.push("F","F");let n=parseInt(e.join(""),16);return{r:n>>24&255,g:n>>16&255,b:n>>8&255,a:n&255,hex:"#"+e.slice(0,6).join("")}}me.getOptions=function(e){e||(e={}),e.color||(e.color={});let n=typeof e.margin>"u"||e.margin===null||e.margin<0?4:e.margin,a=e.width&&e.width>=21?e.width:void 0,r=e.scale||4;return{width:a,scale:a?4:r,margin:n,color:{dark:xr(e.color.dark||"#000000ff"),light:xr(e.color.light||"#ffffffff")},type:e.type,rendererOpts:e.rendererOpts||{}}};me.getScale=function(e,n){return n.width&&n.width>=e+n.margin*2?n.width/(e+n.margin*2):n.scale};me.getImageWidth=function(e,n){let a=me.getScale(e,n);return Math.floor((e+n.margin*2)*a)};me.qrToImageData=function(e,n,a){let r=n.modules.size,o=n.modules.data,i=me.getScale(r,a),c=Math.floor((r+a.margin*2)*i),l=a.margin*i,u=[a.color.light,a.color.dark];for(let R=0;R<c;R++)for(let f=0;f<c;f++){let S=(R*c+f)*4,v=a.color.light;if(R>=l&&f>=l&&R<c-l&&f<c-l){let k=Math.floor((R-l)/i),w=Math.floor((f-l)/i);v=u[o[k*r+w]?1:0]}e[S++]=v.r,e[S++]=v.g,e[S++]=v.b,e[S]=v.a}}});var Mr=p(jt=>{d();var na=ta();function Ku(t,e,n){t.clearRect(0,0,e.width,e.height),e.style||(e.style={}),e.height=n,e.width=n,e.style.height=n+"px",e.style.width=n+"px"}function Wu(){try{return document.createElement("canvas")}catch{throw new Error("You need to specify a canvas element")}}jt.render=function(e,n,a){let r=a,o=n;typeof r>"u"&&(!n||!n.getContext)&&(r=n,n=void 0),n||(o=Wu()),r=na.getOptions(r);let i=na.getImageWidth(e.modules.size,r),c=o.getContext("2d"),l=c.createImageData(i,i);return na.qrToImageData(l.data,e,r),Ku(c,o,i),c.putImageData(l,0,0),o};jt.renderToDataURL=function(e,n,a){let r=a;typeof r>"u"&&(!n||!n.getContext)&&(r=n,n=void 0),r||(r={});let o=jt.render(e,n,r),i=r.type||"image/png",c=r.rendererOpts||{};return o.toDataURL(i,c.quality)}});var Br=p(Pr=>{d();var qu=ta();function Ur(t,e){let n=t.a/255,a=e+'="'+t.hex+'"';return n<1?a+" "+e+'-opacity="'+n.toFixed(2).slice(1)+'"':a}function aa(t,e,n){let a=t+e;return typeof n<"u"&&(a+=" "+n),a}function Yu(t,e,n){let a="",r=0,o=!1,i=0;for(let c=0;c<t.length;c++){let l=Math.floor(c%e),u=Math.floor(c/e);!l&&!o&&(o=!0),t[c]?(i++,c>0&&l>0&&t[c-1]||(a+=o?aa("M",l+n,.5+u+n):aa("m",r,0),r=0,o=!1),l+1<e&&t[c+1]||(a+=aa("h",i),i=0)):r++}return a}Pr.render=function(e,n,a){let r=qu.getOptions(n),o=e.modules.size,i=e.modules.data,c=o+r.margin*2,l=r.color.light.a?"<path "+Ur(r.color.light,"fill")+' d="M0 0h'+c+"v"+c+'H0z"/>':"",u="<path "+Ur(r.color.dark,"stroke")+' d="'+Yu(i,o,r.margin)+'"/>',R='viewBox="0 0 '+c+" "+c+'"',S='<svg xmlns="http://www.w3.org/2000/svg" '+(r.width?'width="'+r.width+'" height="'+r.width+'" ':"")+R+' shape-rendering="crispEdges">'+l+u+`</svg>
`;return typeof a=="function"&&a(null,S),S}});var $r=p(nt=>{d();var Xu=Va(),ra=Dr(),Fr=Mr(),ju=Br();function oa(t,e,n,a,r){let o=[].slice.call(arguments,1),i=o.length,c=typeof o[i-1]=="function";if(!c&&!Xu())throw new Error("Callback required as last argument");if(c){if(i<2)throw new Error("Too few arguments provided");i===2?(r=n,n=e,e=a=void 0):i===3&&(e.getContext&&typeof r>"u"?(r=a,a=void 0):(r=a,a=n,n=e,e=void 0))}else{if(i<1)throw new Error("Too few arguments provided");return i===1?(n=e,e=a=void 0):i===2&&!e.getContext&&(a=n,n=e,e=void 0),new Promise(function(l,u){try{let R=ra.create(n,a);l(t(R,e,a))}catch(R){u(R)}})}try{let l=ra.create(n,a);r(null,t(l,e,a))}catch(l){r(l)}}nt.create=ra.create;nt.toCanvas=oa.bind(null,Fr.render);nt.toDataURL=oa.bind(null,Fr.renderToDataURL);nt.toString=oa.bind(null,function(t,e,n){return ju.render(t,n)})});d();d();d();d();d();var Ro=1,Eo=2,ho=3,Ao=4,Oo=5,No=6,So=7,mo=8,po=9,go=10,fo=11,To=12,Io=-32700,Co=-32603,wo=-32602,Lo=-32601,bo=-32600,yo=-32021,vo=-32020,Do=-32019,xo=-32018,Mo=-32017,Uo=-32016,Po=-32015,Bo=-32014,Fo=-32013,$o=-32012,ko=-32011,Vo=-32010,Go=-32009,zo=-32008,Ho=-32007,Ko=-32006,Wo=-32005,qo=-32004,Yo=-32003,Xo=-32002,jo=-32001,Jo=28e5,Zo=2800001,Qo=2800002,ei=2800003,ti=2800004,ni=2800005,ai=2800006,ri=2800007,oi=2800008,ii=2800009,si=2800010,ci=2800011,li=323e4,di=32300001,_i=3230002,ui=3230003,Ri=3230004,Ei=361e4,hi=3610001,Ai=3610002,Oi=3610003,Ni=3610004,Si=3610005,mi=3610006,pi=3610007,gi=3611e3,fi=3704e3,Ti=3704001,Ii=3704002,Ci=3704003,wi=3704004,Li=3704005,bi=3704006,yi=3712e3,vi=4128e3,Di=4128001,xi=4128002,Mi=4615e3,Ui=4615001,Pi=4615002,Bi=4615003,Fi=4615004,$i=4615005,ki=4615006,Vi=4615007,Gi=4615008,zi=4615009,Hi=4615010,Ki=4615011,Wi=4615012,qi=4615013,Yi=4615014,Xi=4615015,ji=4615016,Ji=4615017,Zi=4615018,Qi=4615019,es=4615020,ts=4615021,ns=4615022,as=4615023,rs=4615024,os=4615025,is=4615026,ss=4615027,cs=4615028,ls=4615029,ds=4615030,_s=4615031,us=4615032,Rs=4615033,Es=4615034,hs=4615035,As=4615036,Os=4615037,Ns=4615038,Ss=4615039,ms=4615040,ps=4615041,gs=4615042,fs=4615043,Ts=4615044,Is=4615045,Cs=4615046,ws=4615047,Ls=4615048,bs=4615049,ys=4615050,vs=4615051,Ds=4615052,xs=4615053,Ms=4615054,Us=5508e3,Ps=5508001,Bs=5508002,Fs=5508003,$s=5508004,ks=5508005,Vs=5508006,Gs=5508007,zs=5508008,Hs=5508009,Ks=5508010,Ws=5508011,qs=5508012,Ys=5607e3,Xs=5607001,js=5607002,Js=5607003,Zs=5607004,Qs=5607005,ec=5607006,tc=5607007,nc=5607008,ac=5607009,rc=5607010,oc=5607011,ic=5607012,sc=5607013,cc=5607014,lc=5607015,dc=5607016,_c=5607017,uc=5607018,Rc=5607019,Ec=5663e3,hc=5663001,Ac=5663002,Oc=5663003,Nc=5663004,Sc=5663005,mc=5663006,pc=5663007,gc=5663008,fc=5663009,Tc=5663010,Ic=5663011,Cc=5663012,wc=5663013,Lc=5663014,bc=5663015,yc=5663016,vc=5663017,Dc=5663018,xc=5663019,Mc=5663020,Uc=5663021,Pc=5663022,Bc=5663023,Fc=5663024,$c=5663025,kc=5663026,Vc=5663027,Gc=5663028,zc=5663029,Hc=5663030,Kc=5663031,Wc=5663032,qc=5663033,Yc=5663034,Xc=5663035,jc=5663036,Jc=5663037,Zc=5663038,Qc=5664e3,el=5664001,tl=705e4,nl=7050001,al=7050002,rl=7050003,ol=7050004,il=7050005,sl=7050006,cl=7050007,ll=7050008,dl=7050009,_l=7050010,ul=7050011,Rl=7050012,El=7050013,hl=7050014,Al=7050015,Ol=7050016,Nl=7050017,Sl=7050018,ml=7050019,pl=7050020,gl=7050021,fl=7050022,Tl=7050023,Il=7050024,Cl=7050025,wl=7050026,Ll=7050027,bl=7050028,yl=7050029,vl=7050030,Dl=7050031,xl=7050032,Ml=7050033,Ul=7050034,Pl=7050035,Bl=7050036,Fl=7618e3,$l=7618001,kl=7618002,Vl=7618003,Gl=7618004,zl=7618005,Hl=7618006,Kl=7618007,Wl=7618008,ql=7618009,Yl=7618010,Xl=7618011,jl=8078e3,Jl=8078001,Zl=8078002,Ql=8078003,ed=8078004,td=8078005,nd=8078006,ad=8078007,rd=8078008,od=8078009,id=8078010,sd=8078011,qe=8078012,cd=8078013,ld=8078014,dd=8078015,_d=8078016,ud=8078017,Rd=8078018,Ed=8078019,hd=8078020,Ad=8078021,Od=8078022,Nd=8078023,Sd=8078024,md=8078025,pd=809e4,gd=8090001,fd=8090002,Td=8090003,Id=8090004,Cd=8090005,wd=8090006,Ld=8090007,bd=8090008,yd=8090009,vd=8090010,Dd=8090011,xd=8090012,Md=81e5,Ud=8100001,Pd=8100002,Bd=8100003,Fd=819e4,$d=8190001,kd=8190002,Vd=8190003,Gd=8190004,zd=8195e3,Hd=8195001,Kd=85e5,Wd=8500001,qd=8500002,Yd=8500003,Xd=8500004,jd=8500005,Jd=8500006,Zd=89e5,Qd=8900001,e_=8900002,t_=8900003,n_=9e6,a_=9000001,r_=9000002,o_=99e5,i_=9900001,s_=9900002,c_=9900003,l_=9900004,d_=9900005,__=9900006;function sa(t){return Array.isArray(t)?"%5B"+t.map(sa).join("%2C%20")+"%5D":typeof t=="bigint"?`${t}n`:encodeURIComponent(String(t!=null&&Object.getPrototypeOf(t)===null?{...t}:t))}function u_([t,e]){return`${t}=${sa(e)}`}function R_(t){let e=Object.entries(t).map(u_).join("&");return btoa(e)}var xR={[li]:"Account not found at address: $address",[Ri]:"Not all accounts were decoded. Encoded accounts found at addresses: $addresses.",[ui]:"Expected decoded account at address: $address",[_i]:"Failed to decode account data at address: $address",[di]:"Accounts not found at addresses: $addresses",[ii]:"Unable to find a viable program address bump seed.",[Qo]:"$putativeAddress is not a base58-encoded address.",[Jo]:"Expected base58 encoded address to decode to a byte array of length 32. Actual length: $actualLength.",[ei]:"The `CryptoKey` must be an `Ed25519` public key.",[ci]:"$putativeOffCurveAddress is not a base58-encoded off-curve address.",[oi]:"Invalid seeds; point must fall off the Ed25519 curve.",[ti]:"Expected given program derived address to have the following format: [Address, ProgramDerivedAddressBump].",[ai]:"A maximum of $maxSeeds seeds, including the bump seed, may be supplied when creating an address. Received: $actual.",[ri]:"The seed at index $index with length $actual exceeds the maximum length of $maxSeedLength bytes.",[ni]:"Expected program derived address bump to be in the range [0, 255], got: $bump.",[si]:"Program address cannot end with PDA marker.",[Zo]:"Expected base58-encoded address string of length in the range [32, 44]. Actual length: $actualLength.",[Ao]:"Expected base58-encoded blockhash string of length in the range [32, 44]. Actual length: $actualLength.",[Ro]:"The network has progressed past the last block for which this transaction could have been committed.",[jl]:"Codec [$codecDescription] cannot decode empty byte arrays.",[Od]:"Enum codec cannot use lexical values [$stringValues] as discriminators. Either remove all lexical values or set `useValuesAsDiscriminators` to `false`.",[hd]:"Sentinel [$hexSentinel] must not be present in encoded bytes [$hexEncodedBytes].",[td]:"Encoder and decoder must have the same fixed size, got [$encoderFixedSize] and [$decoderFixedSize].",[nd]:"Encoder and decoder must have the same max size, got [$encoderMaxSize] and [$decoderMaxSize].",[ed]:"Encoder and decoder must either both be fixed-size or variable-size.",[rd]:"Enum discriminator out of range. Expected a number in [$formattedValidDiscriminators], got $discriminator.",[Zl]:"Expected a fixed-size codec, got a variable-size one.",[cd]:"Codec [$codecDescription] expected a positive byte length, got $bytesLength.",[Ql]:"Expected a variable-size codec, got a fixed-size one.",[Ed]:"Codec [$codecDescription] expected zero-value [$hexZeroValue] to have the same size as the provided fixed-size item [$expectedSize bytes].",[Jl]:"Codec [$codecDescription] expected $expected bytes, got $bytesLength.",[Rd]:"Expected byte array constant [$hexConstant] to be present in data [$hexData] at offset [$offset].",[od]:"Invalid discriminated union variant. Expected one of [$variants], got $value.",[id]:"Invalid enum variant. Expected one of [$stringValues] or a number in [$formattedNumericalValues], got $variant.",[dd]:"Invalid literal union variant. Expected one of [$variants], got $value.",[ad]:"Expected [$codecDescription] to have $expected items, got $actual.",[qe]:"Invalid value $value for base $base with alphabet $alphabet.",[_d]:"Literal union discriminator out of range. Expected a number between $minRange and $maxRange, got $discriminator.",[sd]:"Codec [$codecDescription] expected number to be in the range [$min, $max], got $value.",[ld]:"Codec [$codecDescription] expected offset to be in the range [0, $bytesLength], got $offset.",[Ad]:"Expected sentinel [$hexSentinel] to be present in decoded bytes [$hexDecodedBytes].",[ud]:"Union variant out of range. Expected an index between $minRange and $maxRange, got $variant.",[Nd]:"This decoder expected a byte array of exactly $expectedLength bytes, but $numExcessBytes unexpected excess bytes remained after decoding. Are you sure that you have chosen the correct decoder for this data?",[Sd]:"Invalid pattern match value. The provided value does not match any of the specified patterns.",[md]:"Invalid pattern match bytes. The provided byte array does not match any of the specified patterns.",[gi]:"No random values implementation could be found.",[fo]:"Failed to send transaction$causeMessage",[To]:"Failed to send transactions$causeMessages",[Ld]:"Fixed-point operation `$operation` of kind `$kind` overflowed. Expected a raw bigint in [$min, $max], got $result.",[yd]:"Fixed-point division by zero for value of kind `$kind` ($signedness, $totalBits bits).",[Td]:"`fractionalBits` ($fractionalBits) must not exceed `totalBits` ($totalBits).",[fd]:"Invalid `decimals`. Expected a non-negative integer, got $decimals.",[gd]:"Invalid `fractionalBits`. Expected a non-negative integer, got $fractionalBits.",[Cd]:"Invalid string `$input` for fixed-point value of kind `$kind`.",[pd]:"Invalid `totalBits`. Expected a positive integer, got $totalBits.",[wd]:"Invalid ratio $numerator/$denominator for fixed-point value of kind `$kind`. Denominator must be non-zero.",[Dd]:"Fixed-point value of kind `$kind` has a malformed `raw` field. Expected a bigint, got `$raw`.",[bd]:"Fixed-point `$operation` operation expected $expectedKind ($expectedSignedness, $expectedTotalBits bits, $expectedScale $expectedScaleLabel); got $actualKind ($actualSignedness, $actualTotalBits bits, $actualScale $actualScaleLabel).",[vd]:"Fixed-point operation `$operation` of kind `$kind` cannot be performed exactly; pass a rounding mode other than `strict` to allow a rounded result.",[xd]:"Fixed-point codec of kind `$kind` requires `totalBits` to be a multiple of 8; got $totalBits.",[Id]:"Fixed-point value of kind `$kind` is out of range for $signedness $totalBits-bit storage. Expected a raw bigint in [$min, $max], got $raw.",[yi]:"Filesystem operation `$operation` is not supported in this environment.",[zi]:"Instruction requires an uninitialized account",[as]:"Instruction tries to borrow reference for an account which is already borrowed",[rs]:"Instruction left account with an outstanding borrowed reference",[ts]:"Program other than the account's owner changed the size of the account data",[$i]:"Account data too small for instruction",[ns]:"Instruction expected an executable account",[Cs]:"An account does not have enough lamports to be rent-exempt",[Ls]:"Program arithmetic overflowed",[Is]:"Failed to serialize or deserialize account data",[Ms]:"Builtin programs must consume compute units",[us]:"Cross-program invocation call depth too deep",[Ns]:"Computational budget exceeded",[is]:"Custom program error: #$code",[Ji]:"Instruction contains duplicate accounts",[os]:"Instruction modifications of multiply-passed account differ",[ds]:"Executable accounts must be rent exempt",[cs]:"Instruction changed executable accounts data",[ls]:"Instruction changed the balance of an executable account",[Zi]:"Instruction changed executable bit of an account",[Yi]:"Instruction modified data of an account it does not own",[qi]:"Instruction spent from the balance of an account it does not own",[Ui]:"Generic instruction error",[ys]:"Provided owner is not allowed",[fs]:"Account is immutable",[Ts]:"Incorrect authority provided",[Vi]:"Incorrect program id for instruction",[ki]:"Insufficient funds for instruction",[Fi]:"Invalid account data for instruction",[ws]:"Invalid account owner",[Pi]:"Invalid program argument",[ss]:"Program returned invalid error code",[Bi]:"Invalid instruction data",[Os]:"Failed to reallocate account data",[As]:"Provided seeds do not result in a valid address",[vs]:"Accounts data allocations exceeded the maximum allowed per transaction",[Ds]:"Max accounts exceeded",[xs]:"Max instruction trace length exceeded",[hs]:"Length of the seed is too long for address generation",[Rs]:"An account required by the instruction is missing",[Gi]:"Missing required signature for instruction",[Wi]:"Instruction illegally modified the program id of an account",[es]:"Insufficient account keys for instruction",[Ss]:"Cross-program invocation with unauthorized signer or writable account",[ms]:"Failed to create program execution environment",[gs]:"Program failed to compile",[ps]:"Program failed to complete",[ji]:"Instruction modified data of a read-only account",[Xi]:"Instruction changed the balance of a read-only account",[Es]:"Cross-program invocation reentrancy not allowed for this instruction",[Qi]:"Instruction modified rent epoch of an account",[Ki]:"Sum of account balances before and after instruction do not match",[Hi]:"Instruction requires an initialized account",[Mi]:"The instruction failed with the error: $errorName",[_s]:"Unsupported program id",[bs]:"Unsupported sysvar",[d_]:"Invalid instruction plan kind: $kind.",[kl]:"The provided instruction plan is empty.",[zl]:"No failed transaction plan result was found in the provided transaction plan result.",[Gl]:"This transaction plan executor does not support non-divisible sequential plans. To support them, you may create your own executor such that multi-transaction atomicity is preserved \u2014 e.g. by targetting RPCs that support transaction bundles.",[Vl]:"The provided transaction plan failed to execute. See the `transactionPlanResult` attribute for more details. Note that the `cause` property is deprecated, and a future version will not set it.",[Xl]:"The configured maximum of $maxInstructions instructions per transaction is invalid. It must be a positive integer no greater than the transaction format limit of $transactionInstructionLimit instructions per transaction. Provide a `maxInstructionsPerTransaction` (on the transaction planner) or `maxInstructions` (on the message packer) value between 1 and $transactionInstructionLimit.",[Yl]:"Planning this transaction message would require $numInstructions instructions, which exceeds the configured maximum of $maxInstructions instructions per transaction. This limit is configurable, and intended to leave headroom for inner instructions which are included in the maximum instruction limit for transactions. Increase `maxInstructionsPerTransaction` on the transaction planner (or `maxInstructions` on the message packer) to allow more instructions per transaction.",[Fl]:"The provided message has insufficient capacity to accommodate the next instruction(s) in this plan. Expected at least $numBytesRequired free byte(s), got $numFreeBytes byte(s).",[__]:"Invalid transaction plan kind: $kind.",[$l]:"No more instructions to pack; the message packer has completed the instruction plan.",[Hl]:"Unexpected instruction plan. Expected $expectedKind plan, got $actualKind plan.",[Kl]:"Unexpected transaction plan. Expected $expectedKind plan, got $actualKind plan.",[Wl]:"Unexpected transaction plan result. Expected $expectedKind plan, got $actualKind plan.",[ql]:"Expected a successful transaction plan result. I.e. there is at least one failed or cancelled transaction in the plan.",[vi]:"The instruction does not have any accounts.",[Di]:"The instruction does not have any data.",[xi]:"Expected instruction to have progress address $expectedProgramAddress, got $actualProgramAddress.",[Oo]:"Expected base58 encoded blockhash to decode to a byte array of length 32. Actual length: $actualLength.",[Eo]:"The nonce `$expectedNonceValue` is no longer valid. It has advanced to `$actualNonceValue`",[s_]:"Invariant violation: Found no abortable iterable cache entry for key `$cacheKey`. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",[l_]:"Invariant violation: This data publisher does not publish to the channel named `$channelName`. Supported channels include $supportedChannelNames.",[i_]:"Invariant violation: WebSocket message iterator state is corrupt; iterated without first resolving existing message promise. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",[o_]:"Invariant violation: WebSocket message iterator is missing state storage. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",[c_]:"Invariant violation: Switch statement non-exhaustive. Received unexpected value `$unexpectedValue`. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",[Co]:"JSON-RPC error: Internal JSON-RPC error ($__serverMessage)",[wo]:"JSON-RPC error: Invalid method parameter(s) ($__serverMessage)",[bo]:"JSON-RPC error: The JSON sent is not a valid `Request` object ($__serverMessage)",[Lo]:"JSON-RPC error: The method does not exist / is not available ($__serverMessage)",[Io]:"JSON-RPC error: An error occurred on the server while parsing the JSON text ($__serverMessage)",[$o]:"$__serverMessage",[jo]:"$__serverMessage",[qo]:"$__serverMessage",[Bo]:"$__serverMessage",[Mo]:"Epoch rewards period still active at slot $slot",[vo]:"$__serverMessage",[Vo]:"$__serverMessage",[Go]:"$__serverMessage",[Do]:"Failed to query long-term storage; please try again",[Uo]:"Minimum context slot has not been reached",[Wo]:"Node is unhealthy; behind by $numSlotsBehind slots",[yo]:"No slot history",[zo]:"No snapshot",[Xo]:"Transaction simulation failed",[xo]:"Rewards cannot be found because slot $slot is not the epoch boundary. This may be due to gap in the queried node's local ledger or long-term storage",[Ho]:"$__serverMessage",[ko]:"Transaction history is not available from this node",[Ko]:"$__serverMessage",[Fo]:"Transaction signature length mismatch",[Yo]:"Transaction signature verification failure",[Po]:"$__serverMessage",[Li]:"The grind regex `/$source/` contains the character `$character`, which is not in the base58 alphabet and can never match a Solana address.",[fi]:"Key pair bytes must be of length 64, got $byteLength.",[Ti]:"Expected private key bytes with length 32. Actual length: $actualLength.",[Ii]:"Expected base58-encoded signature to decode to a byte array of length 64. Actual length: $actualLength.",[wi]:"The provided private key does not match the provided public key.",[Ci]:"Expected base58-encoded signature string of length in the range [64, 88]. Actual length: $actualLength.",[bi]:"Writing a key pair to disk is not supported in this environment.",[No]:"Lamports value must be in the range [0, 2e64-1]",[So]:"`$value` cannot be parsed as a `BigInt`",[go]:"$message",[mo]:"`$value` cannot be parsed as a `Number`",[ho]:"No nonce account could be found at address `$nonceAccountAddress`",[Js]:"Expected base58 encoded application domain to decode to a byte array of length 32. Actual length: $actualLength.",[sc]:"Attempted to sign an offchain message with an address that is not a signer for it",[js]:"Expected base58-encoded application domain string of length in the range [32, 44]. Actual length: $actualLength.",[uc]:"The content of the offchain message does not match the content that was expected. Expected content with a byte-length of $expectedBytes; got content with a byte-length of $actualBytes. The signer may have signed different data than was requested; do not trust its signature.",[ic]:"The signer addresses in this offchain message envelope do not match the list of required signers in the message preamble. These unexpected signers were present in the envelope: `[$unexpectedSigners]`. These required signers were missing from the envelope `[$missingSigners]`.",[Ys]:"The message body provided has a byte-length of $actualBytes. The maximum allowable byte-length is $maxBytes",[tc]:"Expected message format $expectedMessageFormat, got $actualMessageFormat",[nc]:"The message length specified in the message preamble is $specifiedLength bytes. The actual length of the message is $actualLength bytes.",[ac]:"Offchain message content must be non-empty",[Qs]:"Offchain message must specify the address of at least one required signer",[rc]:"Offchain message envelope must reserve space for at least one signature",[Zs]:"The offchain message preamble specifies $numRequiredSignatures required signature(s), got $signaturesLength.",[Rc]:"The offchain message lists different required signatories than was expected. Expected [$expectedAddresses]. Got [$actualAddresses]. The signer may have signed different data than was requested; do not trust its signature.",[lc]:"The signatories of this offchain message must be listed in lexicographical order",[dc]:"An address must be listed no more than once among the signatories of an offchain message",[oc]:"Offchain message is missing signatures for addresses: $addresses.",[_c]:"Offchain message signature verification failed. Signature mismatch for required signatories [$signatoriesWithInvalidSignatures]. Missing signatures for signatories [$signatoriesWithMissingSignatures]",[Xs]:"The message body provided contains characters whose codes fall outside the allowed range. In order to ensure clear-signing compatiblity with hardware wallets, the message may only contain line feeds and characters in the range [\\x20-\\x7e].",[cc]:"Expected offchain message version $expectedVersion. Got $actualVersion.",[ec]:"This version of Kit does not support decoding offchain messages with version $unsupportedVersion. The current max supported version is 0.",[Jd]:"The provided account could not be identified as an account from the $programName program.",[qd]:"The provided instruction could not be identified as an instruction from the $programName program.",[Kd]:"The provided instruction is missing some accounts. Expected at least $expectedAccountMetas account(s), got $actualAccountMetas.",[Xd]:"Expected resolved instruction input '$inputName' to be non-null.",[Yd]:"Expected resolved instruction input '$inputName' to be of type `$expectedType`.",[jd]:"Unrecognized account type '$accountType' for the $programName program.",[Wd]:"Unrecognized instruction type '$instructionType' for the $programName program.",[Fd]:"The notification name must end in 'Notifications' and the API must supply a subscription plan creator function for the notification '$notificationName'.",[kd]:"WebSocket was closed before payload could be added to the send buffer",[Vd]:"WebSocket connection closed",[Gd]:"WebSocket failed to connect",[$d]:"Failed to obtain a subscription id from the server",[Bd]:"Could not find an API plan for RPC method: `$method`",[Md]:"The $argumentLabel argument to the `$methodName` RPC method$optionalPathLabel was `$value`. This number is unsafe for use with the Solana JSON-RPC because it exceeds `Number.MAX_SAFE_INTEGER`.",[Pd]:"HTTP error ($statusCode): $message",[Ud]:"HTTP header(s) forbidden: $headers. Learn more at https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name.",[Us]:"Multiple distinct signers were identified for address `$address`. Please ensure that you are using the same signer instance for each address.",[Ps]:"The provided value does not implement the `KeyPairSigner` interface",[Fs]:"The provided value does not implement the `MessageModifyingSigner` interface",[$s]:"The provided value does not implement the `MessagePartialSigner` interface",[Bs]:"The provided value does not implement any of the `MessageSigner` interfaces",[Vs]:"The provided value does not implement the `TransactionModifyingSigner` interface",[Gs]:"The provided value does not implement the `TransactionPartialSigner` interface",[zs]:"The provided value does not implement the `TransactionSendingSigner` interface",[ks]:"The provided value does not implement any of the `TransactionSigner` interfaces",[Hs]:"More than one `TransactionSendingSigner` was identified.",[Ks]:"No `TransactionSendingSigner` was identified. Please provide a valid `TransactionWithSingleSendingSigner` transaction.",[qs]:"The wallet account $address cannot be used to create a transaction signer because it does not implement either the `solana:signTransaction` or `solana:signAndSendTransaction` feature. At least one of these features is required. The account supports the following features: $supportedFeatures.",[Ws]:"Wallet account signers do not support signing multiple messages/transactions in a single operation",[zd]:"This `ReactiveStreamStore` does not support retry. Use `createReactiveStoreFromDataPublisherFactory` to construct a retryable store.",[Hd]:"The stream store closed in an error state but did not report an error.",[pi]:"Cannot export a non-extractable key.",[hi]:"No digest implementation could be found.",[Ei]:"Cryptographic operations are only allowed in secure browser contexts. Read more here: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts.",[Ai]:`This runtime does not support the generation of Ed25519 key pairs.

Install @solana/webcrypto-ed25519-polyfill and call its \`install\` function before generating keys in environments that do not support Ed25519.

For a list of runtimes that currently support Ed25519 operations, visit https://github.com/WICG/webcrypto-secure-curves/issues/20.`,[Oi]:"No key export implementation could be found.",[Ni]:"No key generation implementation could be found.",[Si]:"No signing implementation could be found.",[mi]:"No signature verification implementation could be found.",[po]:"Timestamp value must be in the range [-(2n ** 63n), (2n ** 63n) - 1]. `$value` given",[Ol]:"Transaction processing left an account with an outstanding borrowed reference",[nl]:"Account in use",[al]:"Account loaded twice",[rl]:"Attempt to debit an account but found no record of a prior credit.",[Tl]:"Transaction loads an address table account that doesn't exist",[cl]:"This transaction has already been processed",[ll]:"Blockhash not found",[dl]:"Loader call chain is too deep",[Al]:"Transactions are currently disabled due to cluster maintenance",[vl]:"Transaction contains a duplicate instruction ($index) that is not allowed",[il]:"Insufficient funds for fee",[Dl]:"Transaction results in an account ($accountIndex) with insufficient funds for rent",[sl]:"This account may not be used to pay transaction fees",[ul]:"Transaction contains an invalid account reference",[Cl]:"Transaction loads an address table account with invalid data",[wl]:"Transaction address table lookup uses an invalid index",[Il]:"Transaction loads an address table account with an invalid owner",[Ml]:"LoadedAccountsDataSizeLimit set for transaction must be greater than 0.",[El]:"This program may not be used for executing instructions",[Ll]:"Transaction leaves an account with a lower balance than rent-exempt minimum",[ml]:"Transaction loads a writable account that cannot be written",[xl]:"Transaction exceeded max loaded accounts data size cap",[_l]:"Transaction requires a fee but has no signature present",[ol]:"Attempt to load a program that does not exist",[Pl]:"Execution of the program referenced by account at index $accountIndex is temporarily restricted.",[Ul]:"ResanitizationNeeded",[hl]:"Transaction failed to sanitize accounts offsets correctly",[Rl]:"Transaction did not pass signature verification",[fl]:"Transaction locked too many accounts",[Bl]:"Sum of account balances before and after transaction do not match",[tl]:"The transaction failed with the error `$errorName`",[Sl]:"Transaction version is unsupported",[gl]:"Transaction would exceed account data limit within the block",[yl]:"Transaction would exceed total account data limit",[pl]:"Transaction would exceed max account limit within the block",[Nl]:"Transaction would exceed max Block Cost Limit",[bl]:"Transaction would exceed max Vote Cost Limit",[bc]:"Attempted to sign a transaction with an address that is not a signer for it",[Tc]:"Transaction is missing an address at index: $index.",[yc]:"Transaction has no expected signers therefore it cannot be encoded",[Mc]:"Transaction size $transactionSize exceeds limit of $transactionSizeLimit bytes",[Ac]:"Transaction does not have a blockhash lifetime",[Oc]:"Transaction is not a durable nonce transaction",[Sc]:"Contents of these address lookup tables unknown: $lookupTableAddresses",[mc]:"Lookup of address at index $highestRequestedIndex failed for lookup table `$lookupTableAddress`. Highest known index is $highestKnownIndex. The lookup table may have been extended since its contents were retrieved",[gc]:"No fee payer set in CompiledTransaction",[pc]:"Could not find program address at index $index",[Dc]:"Failed to estimate the compute unit consumption for this transaction message. This is likely because simulating the transaction failed. Inspect the `cause` property of this error to learn more",[jc]:"Failed to estimate the loaded accounts data size for this transaction message. The RPC did not return a `loadedAccountsDataSize` value from simulation. This value is required for version 1 transactions",[xc]:"Transaction failed when it was simulated in order to estimate the compute unit consumption. The compute unit estimate provided is for a transaction that failed when simulated and may not be representative of the compute units this transaction would consume if successful. Inspect the `cause` property of this error to learn more",[Jc]:"Transaction failed when it was simulated in order to estimate its resource limits. The resource limit estimates provided are for a transaction that failed when simulated and may not be representative of the resources this transaction would consume if successful. Inspect the `cause` property of this error to learn more",[Ic]:"Transaction is missing a fee payer.",[Cc]:"Could not determine this transaction's signature. Make sure that the transaction has been signed by its fee payer.",[Lc]:"Transaction first instruction is not advance nonce account instruction.",[wc]:"Transaction with no instructions cannot be durable nonce transaction.",[Ec]:"This transaction includes an address (`$programAddress`) which is both invoked and set as the fee payer. Program addresses may not pay fees",[hc]:"This transaction includes an address (`$programAddress`) which is both invoked and marked writable. Program addresses may not be writable",[vc]:"The transaction message expected the transaction to have $numRequiredSignatures signatures, got $signaturesLength.",[fc]:"Transaction is missing signatures for addresses: $addresses.",[Nc]:"Transaction version must be in the range [0, 127]. `$actualVersion` given",[Uc]:"This version of Kit does not support decoding transactions with version $unsupportedVersion. The current max supported version is 1.",[Pc]:"The transaction has a durable nonce lifetime (with nonce `$nonce`), but the nonce account address is in a lookup table. The lifetime constraint cannot be constructed without fetching the lookup tables for the transaction.",[Gc]:"Invalid transaction config mask: $mask. Bits 0 and 1 must match (both set or both unset)",[Bc]:"Transaction message bytes are malformed: $messageBytes",[Fc]:"Transaction message bytes are empty, so the transaction cannot be encoded",[$c]:"Transaction bytes are empty, so no transaction can be decoded",[kc]:"Transaction version 0 must be encoded with signatures first. This transaction was encoded with first byte $firstByte, which is expected to be a signature count for v0 transactions.",[Vc]:"The provided transaction bytes expect that there should be $numExpectedSignatures signatures, but the bytes are not long enough to contain a transaction message with this many signatures. The provided bytes are $transactionBytesLength bytes long.",[zc]:"The transaction has a durable nonce lifetime, but the nonce account index is invalid. Expected a nonce account index less than $numberOfStaticAccounts, got $nonceAccountIndex.",[Hc]:"The transaction config value for $configName has the incorrect kind. Expected $expectedKind, got $actualKind.",[Kc]:"The transaction does not have the same number of instruction headers and instruction payloads. Got $numInstructionHeaders instruction headers, and $numInstructionPayloads instruction payloads.",[Wc]:"Transaction has $actualCount unique signer addresses but the maximum allowed is $maxAllowed",[qc]:"Transaction has $actualCount unique account addresses but the maximum allowed is $maxAllowed",[Yc]:"Transaction has $actualCount instructions but the maximum allowed is $maxAllowed",[Xc]:"The instruction at index $instructionIndex has $actualCount account references but the maximum allowed is $maxAllowed",[Zc]:"Could not find an account address at index $index while decompiling an instruction",[Qc]:"`getTransaction` responses fetched with `encoding: 'jsonParsed'` cannot be decoded. Re-fetch the transaction with `encoding: 'base64'`, `'base58'`, or `'json'`",[el]:"Could not recognize the shape of this `getTransaction` response. Expected a response fetched with `encoding: 'base64'`, `'base58'`, or `'json'`",[a_]:"`$hookName` requires the following capabilities to be installed on the client: [$capabilities]. $providerHint",[n_]:"`$hookName` was called outside of a `ClientProvider`. Mount a `<ClientProvider client={client}>` in the ancestor tree.",[r_]:"The subscription closed in an error state but did not report an error.",[Zd]:"Cannot $operation: no wallet connected",[Qd]:"No signing wallet connected (status: $status)",[e_]:"Connected wallet does not support signing",[t_]:'Account $address is not available in wallet "$walletName"'};function E_(t,e={}){{let n=`Solana error #${t}; Decode this error by running \`npx @solana/errors decode -- ${t}`;return Object.keys(e).length&&(n+=` '${R_(e)}'`),`${n}\``}}var Lt=class extends Error{constructor(...[e,n]){let a,r;n&&Object.entries(Object.getOwnPropertyDescriptors(n)).forEach(([i,c])=>{i==="cause"?r={cause:c.value}:(a===void 0&&(a={__code:e}),Object.defineProperty(a,i,c))});let o=E_(e,a);super(o,r);C(this,"cause",this.cause);C(this,"context");this.context=Object.freeze(a===void 0?{__code:e}:a),this.name="SolanaError"}};d();d();function h_(t,e){return"fixedSize"in e?e.fixedSize:e.getSizeFromValue(t)}function bt(t){return Object.freeze({...t,encode:e=>{let n=new Uint8Array(h_(e,t));return t.write(e,n,0),n}})}function yt(t){return Object.freeze({...t,decode:(e,n=0)=>t.read(e,n)[0]})}function A_(t,e,n=e){if(!e.match(new RegExp(`^[${t}]*$`)))throw new Lt(qe,{alphabet:t,base:t.length,value:n})}var O_=t=>bt({getSizeFromValue:e=>{let[n,a]=ca(e,t[0]);if(!a)return e.length;let r=la(a,t);return n.length+Math.ceil(r.toString(16).length/2)},write(e,n,a){if(A_(t,e),e==="")return a;let[r,o]=ca(e,t[0]);if(!o)return n.set(new Uint8Array(r.length).fill(0),a),a+r.length;let i=la(o,t),c=[];for(;i>0n;)c.unshift(Number(i%256n)),i/=256n;let l=[...Array(r.length).fill(0),...c];return n.set(l,a),a+l.length}}),N_=t=>yt({read(e,n){let a=n===0||n<=-e.byteLength?e:e.slice(n);if(a.length===0)return["",e.length];let r=a.findIndex(l=>l!==0);r=r===-1?a.length:r;let o=t[0].repeat(r);if(r===a.length)return[o,e.length];let i=a.slice(r).reduce((l,u)=>l*256n+BigInt(u),0n),c=S_(i,t);return[o+c,e.length]}});function ca(t,e){let[n,a]=t.split(new RegExp(`((?!${e}).*)`));return[n,a]}function la(t,e){let n=BigInt(e.length),a=0n;for(let r of t)a*=n,a+=BigInt(e.indexOf(r));return a}function S_(t,e){let n=BigInt(e.length),a=[];for(;t>0n;)a.unshift(e[Number(t%n)]),t/=n;return a.join("")}var ua="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",Ra=()=>O_(ua),Ea=()=>N_(ua);var da="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",ha=()=>bt({getSizeFromValue:t=>{try{return atob(t).length}catch{throw new Lt(qe,{alphabet:da,base:64,value:t})}},write(t,e,n){try{let a=atob(t).split("").map(r=>r.charCodeAt(0));return e.set(a,n),a.length+n}catch{throw new Lt(qe,{alphabet:da,base:64,value:t})}}}),In=()=>yt({read(t,e=0){let n=t.slice(e);return[btoa(String.fromCharCode(...n)),t.length]}});var m_=t=>t.replace(/\u0000/g,"");var p_=globalThis.TextDecoder,_a=globalThis.TextEncoder,Cn=()=>{let t;return bt({getSizeFromValue:e=>(t||(t=new _a)).encode(e).length,write:(e,n,a)=>{let r=(t||(t=new _a)).encode(e);return n.set(r,a),a+r.length}})},Aa=()=>{let t;return yt({read(e,n){let a=(t||(t=new p_)).decode(e.slice(n));return[m_(a),e.length]}})};function Oa(t){return In().decode(Cn().encode(t))}function ee(t,e){let n=In().decode(t);return e?n.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""):n}function Ye(t){return ha().encode(t)}function Na(t){return Ea().decode(t)}function g_(t){return Ra().encode(t)}function Sa(t){return Na(Ye(t))}function vt(t){return ee(new Uint8Array(t))}function Ce(t){return Na(t)}function wn(t){return g_(t)}function Y(t){return ee(t)}function x(t){return Ye(t)}function Ln(t){return Aa().decode(t)}function bn(t){return Cn().encode(t)}d();var yn="solana:mainnet";d();var f_=function(t,e,n,a){if(n==="a"&&!a)throw new TypeError("Private accessor was defined without a getter");if(typeof e=="function"?t!==e||!a:!e.has(t))throw new TypeError("Cannot read private member from an object whose class did not declare it");return n==="m"?a:n==="a"?a.call(t):a?a.value:e.get(t)},T_=function(t,e,n,a,r){if(a==="m")throw new TypeError("Private method is not writable");if(a==="a"&&!r)throw new TypeError("Private accessor was defined without a setter");if(typeof e=="function"?t!==e||!r:!e.has(t))throw new TypeError("Cannot write private member to an object whose class did not declare it");return a==="a"?r.call(t,n):r?r.value=n:e.set(t,n),n},Dt;function Dn(t){let e=({register:n})=>n(t);try{window.dispatchEvent(new vn(e))}catch(n){console.error(`wallet-standard:register-wallet event could not be dispatched
`,n)}try{window.addEventListener("wallet-standard:app-ready",({detail:n})=>e(n))}catch(n){console.error(`wallet-standard:app-ready event listener could not be added
`,n)}}var vn=class extends Event{get detail(){return f_(this,Dt,"f")}get type(){return"wallet-standard:register-wallet"}constructor(e){super("wallet-standard:register-wallet",{bubbles:!1,cancelable:!1,composed:!1}),Dt.set(this,void 0),T_(this,Dt,e,"f")}preventDefault(){throw new Error("preventDefault cannot be called")}stopImmediatePropagation(){throw new Error("stopImmediatePropagation cannot be called")}stopPropagation(){throw new Error("stopPropagation cannot be called")}};Dt=new WeakMap;d();d();var I_="(?<domain>[^\\n]+?) wants you to sign in with your Solana account:\\n",C_="(?<address>[^\\n]+)(?:\\n|$)",w_="(?:\\n(?<statement>[\\S\\s]*?)(?:\\n|$))??",L_="(?:\\nURI: (?<uri>[^\\n]+))?",b_="(?:\\nVersion: (?<version>[^\\n]+))?",y_="(?:\\nChain ID: (?<chainId>[^\\n]+))?",v_="(?:\\nNonce: (?<nonce>[^\\n]+))?",D_="(?:\\nIssued At: (?<issuedAt>[^\\n]+))?",x_="(?:\\nExpiration Time: (?<expirationTime>[^\\n]+))?",M_="(?:\\nNot Before: (?<notBefore>[^\\n]+))?",U_="(?:\\nRequest ID: (?<requestId>[^\\n]+))?",P_="(?:\\nResources:(?<resources>(?:\\n- [^\\n]+)*))?",B_=`${L_}${b_}${y_}${v_}${D_}${x_}${M_}${U_}${P_}`,rE=new RegExp(`^${I_}${C_}${w_}${B_}\\n*$`);function ma(t){let e=`${t.domain} wants you to sign in with your Solana account:
`;e+=`${t.address}`,t.statement&&(e+=`

${t.statement}`);let n=[];if(t.uri&&n.push(`URI: ${t.uri}`),t.version&&n.push(`Version: ${t.version}`),t.chainId&&n.push(`Chain ID: ${t.chainId}`),t.nonce&&n.push(`Nonce: ${t.nonce}`),t.issuedAt&&n.push(`Issued At: ${t.issuedAt}`),t.expirationTime&&n.push(`Expiration Time: ${t.expirationTime}`),t.notBefore&&n.push(`Not Before: ${t.notBefore}`),t.requestId&&n.push(`Request ID: ${t.requestId}`),t.resources){n.push("Resources:");for(let a of t.resources)n.push(`- ${a}`)}return n.length&&(e+=`

${n.join(`
`)}`),e}var T={ERROR_ASSOCIATION_PORT_OUT_OF_RANGE:"ERROR_ASSOCIATION_PORT_OUT_OF_RANGE",ERROR_REFLECTOR_ID_OUT_OF_RANGE:"ERROR_REFLECTOR_ID_OUT_OF_RANGE",ERROR_FORBIDDEN_WALLET_BASE_URL:"ERROR_FORBIDDEN_WALLET_BASE_URL",ERROR_SECURE_CONTEXT_REQUIRED:"ERROR_SECURE_CONTEXT_REQUIRED",ERROR_SESSION_CLOSED:"ERROR_SESSION_CLOSED",ERROR_SESSION_TIMEOUT:"ERROR_SESSION_TIMEOUT",ERROR_WALLET_NOT_FOUND:"ERROR_WALLET_NOT_FOUND",ERROR_INVALID_PROTOCOL_VERSION:"ERROR_INVALID_PROTOCOL_VERSION",ERROR_BROWSER_NOT_SUPPORTED:"ERROR_BROWSER_NOT_SUPPORTED",ERROR_LOOPBACK_ACCESS_BLOCKED:"ERROR_LOOPBACK_ACCESS_BLOCKED",ERROR_ASSOCIATION_CANCELLED:"ERROR_ASSOCIATION_CANCELLED",ERROR_ILLEGAL_TRANSPORT_STATE:"ERROR_ILLEGAL_TRANSPORT_STATE"},g=class extends Error{constructor(...e){let[n,a,r]=e;super(a);C(this,"data");C(this,"code");this.code=n,this.data=r,this.name="SolanaMobileWalletAdapterError"}};var xn=class extends Error{constructor(...e){let[n,a,r,o]=e;super(r);C(this,"data");C(this,"code");C(this,"jsonRpcMessageId");this.code=a,this.data=o,this.jsonRpcMessageId=n,this.name="SolanaMobileWalletAdapterProtocolError"}};async function xt(t,e){let n=await crypto.subtle.exportKey("raw",t),a=await crypto.subtle.sign({hash:"SHA-256",name:"ECDSA"},e,n),r=new Uint8Array(n.byteLength+a.byteLength);return r.set(new Uint8Array(n),0),r.set(new Uint8Array(a),n.byteLength),r}function F_(t){return ma(t)}function $_(t){return Oa(F_(t)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}var k_="solana:signTransactions",pa="solana:cloneAuthorization";function Ta(t,e){return new Proxy({},{get(n,a){return a==="then"?null:(n[a]==null&&(n[a]=async function(r){let{method:o,params:i}=V_(a,r,t),c=await e(o,i);return o==="authorize"&&i.sign_in_payload&&!c.sign_in_result&&(c.sign_in_result=await z_(i.sign_in_payload,c,e)),G_(a,c,t)}),n[a])},defineProperty(){return!1},deleteProperty(){return!1}})}function V_(t,e,n){let a=e,r=t.toString().replace(/[A-Z]/g,o=>`_${o.toLowerCase()}`).toLowerCase();switch(t){case"authorize":{let o=a,{chain:i}=o;if(n==="legacy"){switch(i){case"solana:testnet":i="testnet";break;case"solana:devnet":i="devnet";break;case"solana:mainnet":i="mainnet-beta";break;default:i=o.cluster}o.cluster=i,a=o}else{switch(i){case"testnet":case"devnet":i=`solana:${i}`;break;case"mainnet-beta":i="solana:mainnet"}o.chain=i,a=o}}case"reauthorize":{let{auth_token:o,identity:i}=a;o&&(n==="legacy"?(r="reauthorize",a={auth_token:o,identity:i}):r="authorize");break}}return{method:r,params:a}}function G_(t,e,n){switch(t){case"getCapabilities":{let a=e;switch(n){case"legacy":{let r=[k_];return a.supports_clone_authorization===!0&&r.push(pa),{...a,features:r}}case"v1":return{...a,supports_sign_and_send_transactions:!0,supports_clone_authorization:a.features.includes(pa)}}}}return e}async function z_(t,e,n){let a=t.domain??window.location.host,r=e.accounts[0].address,o=$_({...t,domain:a,address:Sa(r)}),i=await n("sign_messages",{addresses:[r],payloads:[o]}),c=Ye(i.signed_payloads[0]),l=ee(c.slice(0,c.length-64)),u=ee(c.slice(c.length-64));return{address:r,signed_message:l.length==0?o:l,signature:u}}function H_(t){if(t>=4294967296)throw new Error("Outbound sequence number overflow. The maximum sequence number is 32-bytes.");let e=new ArrayBuffer(4);return new DataView(e).setUint32(0,t,!1),new Uint8Array(e)}var K_=12;async function W_(t,e,n){let a=H_(e),r=new Uint8Array(K_);crypto.getRandomValues(r);let o=await crypto.subtle.encrypt(Ca(a,r),n,bn(t)),i=new Uint8Array(a.byteLength+r.byteLength+o.byteLength);return i.set(new Uint8Array(a),0),i.set(new Uint8Array(r),a.byteLength),i.set(new Uint8Array(o),a.byteLength+r.byteLength),i}async function Ia(t,e){let n=t.slice(0,4),a=t.slice(4,16),r=t.slice(16),o=await crypto.subtle.decrypt(Ca(n,a),e,r);return Ln(new Uint8Array(o))}function Ca(t,e){return{additionalData:t,iv:e,name:"AES-GCM",tagLength:128}}async function wa(){return await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},!1,["sign"])}async function Mt(){return await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},!1,["deriveKey","deriveBits"])}function q_(){return La(49152+Math.floor(Math.random()*16384))}function La(t){if(t<49152||t>65535)throw new g(T.ERROR_ASSOCIATION_PORT_OUT_OF_RANGE,`Association port number must be between 49152 and 65535. ${t} given.`,{port:t});return t}function ba(t){return t.replace(/[/+=]/g,e=>({"/":"_","+":"-","=":"."})[e])}var Y_="solana-wallet";function ga(t){return t.replace(/(^\/+|\/+$)/g,"").split("/")}function ya(t,e){let n=null;if(e){try{n=new URL(e)}catch{}if(n?.protocol!=="https:")throw new g(T.ERROR_FORBIDDEN_WALLET_BASE_URL,"Base URLs supplied by wallets must be valid `https` URLs")}n||(n=new URL(`${Y_}:/`));let a=t.startsWith("/")?t:[...ga(n.pathname),...ga(t)].join("/");return new URL(a,n)}async function X_(t,e,n,a=["v1"]){let r=La(e),o=await crypto.subtle.exportKey("raw",t),i=vt(o),c=ya("v1/associate/local",n);return c.searchParams.set("association",ba(i)),c.searchParams.set("port",`${r}`),a.forEach(l=>{c.searchParams.set("v",l)}),c}async function j_(t,e,n,a,r=["v1"]){let o=await crypto.subtle.exportKey("raw",t),i=vt(o),c=ya("v1/associate/remote",a);return c.searchParams.set("association",ba(i)),c.searchParams.set("reflector",`${e}`),c.searchParams.set("id",`${ee(n,!0)}`),r.forEach(l=>{c.searchParams.set("v",l)}),c}async function va(t,e){let n=JSON.stringify(t),a=t.id;return W_(n,a,e)}async function Da(t,e){let n=await Ia(t,e),a=JSON.parse(n);if(Object.hasOwnProperty.call(a,"error"))throw new xn(a.id,a.error.code,a.error.message);return a}async function xa(t,e,n){let[a,r]=await Promise.all([crypto.subtle.exportKey("raw",e),crypto.subtle.importKey("raw",t.slice(0,65),{name:"ECDH",namedCurve:"P-256"},!1,[])]),o=await crypto.subtle.deriveBits({name:"ECDH",public:r},n,256),i=await crypto.subtle.importKey("raw",o,"HKDF",!1,["deriveKey"]);return await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(a),info:new Uint8Array},i,{name:"AES-GCM",length:128},!1,["encrypt","decrypt"])}async function Ma(t,e){let n=await Ia(t,e),a=JSON.parse(n),r="legacy";if(Object.hasOwnProperty.call(a,"v"))switch(a.v){case 1:case"1":case"v1":r="v1";break;case"legacy":r="legacy";break;default:throw new g(T.ERROR_INVALID_PROTOCOL_VERSION,`Unknown/unsupported protocol version: ${a.v}`)}return{protocol_version:r}}var Ut={Firefox:0,Other:1};function J_(){return navigator.userAgent.indexOf("Firefox/")!==-1?Ut.Firefox:Ut.Other}function Z_(){return new Promise((t,e)=>{function n(){clearTimeout(r),window.removeEventListener("blur",a)}function a(){n(),t()}window.addEventListener("blur",a);let r=setTimeout(()=>{n(),e()},3e3)})}var we=null;function Q_(t){(we==null||!we.isConnected)&&(we=document.createElement("iframe"),we.style.display="none",document.body.appendChild(we)),we.contentWindow.location.href=t.toString()}async function eu(t){if(t.protocol==="https:")window.location.assign(t);else try{switch(J_()){case Ut.Firefox:Q_(t);break;case Ut.Other:{let e=Z_();window.location.assign(t),await e;break}}}catch{throw new g(T.ERROR_WALLET_NOT_FOUND,"Found no installed wallet that supports the mobile wallet protocol.")}}async function tu(t,e){let n=q_();return await eu(await X_(t,n,e)),n}var Pt={retryDelayScheduleMs:[150,150,200,500,500,750,750,1e3],timeoutMs:3e4},Ua="com.solana.mobilewalletadapter.v1",fa="com.solana.mobilewalletadapter.v1.base64";function Pa(){if(typeof window>"u"||window.isSecureContext!==!0)throw new g(T.ERROR_SECURE_CONTEXT_REQUIRED,"The mobile wallet adapter protocol must be used in a secure context (`https`).")}function Ba(t){let e;try{e=new URL(t)}catch{throw new g(T.ERROR_FORBIDDEN_WALLET_BASE_URL,"Invalid base URL supplied by wallet")}if(e.protocol!=="https:")throw new g(T.ERROR_FORBIDDEN_WALLET_BASE_URL,"Base URLs supplied by wallets must be valid `https` URLs")}function Bt(t){return new DataView(t).getUint32(0,!1)}function nu(t){let e=new Uint8Array(t),n=t.byteLength,a=10,r=0,o=0,i;do{if(o>=n||o>a)throw new RangeError("Failed to decode varint");i=e[o++],r|=(i&127)<<7*o}while(i>=128);return{value:r,offset:o}}function au(t){let{value:e,offset:n}=nu(t);return new Uint8Array(t.slice(n,n+e))}async function Fa(t){Pa();let e=await wa(),n=`ws://localhost:${await tu(e.publicKey,t?.baseUri)}/solana-wallet`,a,r=(()=>{let f=[...Pt.retryDelayScheduleMs];return()=>f.length>1?f.shift():f[0]})(),o=1,i=0,c={__type:"disconnected"},l,u=!1,R;return{close:()=>{l.close(),R()},wallet:new Promise((f,S)=>{let v={},k=async()=>{if(c.__type!=="connecting"){console.warn(`Expected adapter state to be \`connecting\` at the moment the websocket opens. Got \`${c.__type}\`.`);return}l.removeEventListener("open",k);let{associationKeypair:A}=c,O=await Mt();l.send(await xt(O.publicKey,A.privateKey)),c={__type:"hello_req_sent",associationPublicKey:A.publicKey,ecdhPrivateKey:O.privateKey}},w=A=>{A.wasClean?c={__type:"disconnected"}:S(new g(T.ERROR_SESSION_CLOSED,`The wallet session dropped unexpectedly (${A.code}: ${A.reason}).`,{closeEvent:A})),G()},$=async A=>{G(),Date.now()-a>=Pt.timeoutMs?S(new g(T.ERROR_SESSION_TIMEOUT,`Failed to connect to the wallet websocket at ${n}.`)):(await new Promise(O=>{let N=r();q=window.setTimeout(O,N)}),V())},M=async A=>{let O=await A.data.arrayBuffer();switch(c.__type){case"connecting":{if(O.byteLength!==0){S(new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while connecting"));return}let N=await Mt();l.send(await xt(N.publicKey,e.privateKey)),c={__type:"hello_req_sent",associationPublicKey:e.publicKey,ecdhPrivateKey:N.privateKey};break}case"connected":try{let N=Bt(O.slice(0,4));if(N!==i+1)throw new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number");i=N;let L=await Da(O,c.sharedSecret),U=v[L.id];delete v[L.id],U.resolve(L.result)}catch(N){if(N instanceof xn){let L=v[N.jsonRpcMessageId];delete v[N.jsonRpcMessageId],L.reject(N)}else throw N}break;case"hello_req_sent":{if(O.byteLength===0){let H=await Mt();l.send(await xt(H.publicKey,e.privateKey)),c={__type:"hello_req_sent",associationPublicKey:e.publicKey,ecdhPrivateKey:H.privateKey};break}let N=await xa(O,c.associationPublicKey,c.ecdhPrivateKey),L=O.slice(65),U=L.byteLength!==0?await(async()=>{let H=Bt(L.slice(0,4));return H!==i+1?(S(new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number")),l.close(),{protocol_version:"v1"}):(i=H,Ma(L,N))})():{protocol_version:"legacy"};c={__type:"connected",sharedSecret:N,sessionProperties:U};let He=Ta(U.protocol_version,async(H,Tt)=>{let It=o++;return l.send(await va({id:It,jsonrpc:"2.0",method:H,params:Tt??{}},N)),new Promise((Ct,Ke)=>{v[It]={resolve(We){switch(H){case"authorize":case"reauthorize":{let{wallet_uri_base:wt}=We;if(wt!=null)try{Ba(wt)}catch(_o){Ke(_o);return}break}}Ct(We)},reject:Ke}})});u=!0;try{f(He)}catch(H){S(H)}break}}};R=()=>{l.removeEventListener("message",M),G(),u||S(new g(T.ERROR_SESSION_CLOSED,"The wallet session was closed before connection.",{closeEvent:new CloseEvent("socket was closed before connection")}))};let G,q,V=()=>{G&&G(),c={__type:"connecting",associationKeypair:e},a===void 0&&(a=Date.now()),l=new WebSocket(n,[Ua]),l.addEventListener("open",k),l.addEventListener("close",w),l.addEventListener("error",$),l.addEventListener("message",M),G=()=>{window.clearTimeout(q),l.removeEventListener("open",k),l.removeEventListener("close",w),l.removeEventListener("error",$),l.removeEventListener("message",M)}};V()})}}async function $a(t){Pa();let e=await wa(),n=`wss://${t?.remoteHostAuthority}/reflect`,a,r=(()=>{let w=[...Pt.retryDelayScheduleMs];return()=>w.length>1?w.shift():w[0]})(),o=1,i=0,c,l={__type:"disconnected"},u,R,f=async w=>{if(c=="base64"){let $=await w.data;return Ye($).buffer}else return await w.data.arrayBuffer()},S=await new Promise((w,$)=>{let M=async()=>{if(l.__type!=="connecting"){console.warn(`Expected adapter state to be \`connecting\` at the moment the websocket opens. Got \`${l.__type}\`.`);return}u.protocol.includes(fa)?c="base64":c="binary",u.removeEventListener("open",M)},G=N=>{N.wasClean?l={__type:"disconnected"}:$(new g(T.ERROR_SESSION_CLOSED,`The wallet session dropped unexpectedly (${N.code}: ${N.reason}).`,{closeEvent:N})),R()},q=async N=>{R(),Date.now()-a>=Pt.timeoutMs?$(new g(T.ERROR_SESSION_TIMEOUT,`Failed to connect to the wallet websocket at ${n}.`)):(await new Promise(L=>{let U=r();A=window.setTimeout(L,U)}),O())},V=async N=>{let L=await f(N);if(l.__type==="connecting"){if(L.byteLength==0){$(new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while connecting")),u.close();return}let U=au(L);l={__type:"reflector_id_received",reflectorId:U};let He=await j_(e.publicKey,t.remoteHostAuthority,U,t?.baseUri);u.removeEventListener("message",V),w(He)}},A,O=()=>{R&&R(),l={__type:"connecting",associationKeypair:e},a===void 0&&(a=Date.now()),u=new WebSocket(n,[Ua,fa]),u.addEventListener("open",M),u.addEventListener("close",G),u.addEventListener("error",q),u.addEventListener("message",V),R=()=>{window.clearTimeout(A),u.removeEventListener("open",M),u.removeEventListener("close",G),u.removeEventListener("error",q),u.removeEventListener("message",V)}};O()}),v=!1,k;return{associationUrl:S,close:()=>{u.close(),k()},wallet:new Promise((w,$)=>{let M={},G=async q=>{let V=await f(q);switch(l.__type){case"reflector_id_received":{if(V.byteLength!==0){$(new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encountered unexpected message while awaiting reflection")),u.close();return}let A=await Mt(),O=await xt(A.publicKey,e.privateKey);c=="base64"?u.send(ee(O)):u.send(O),l={__type:"hello_req_sent",associationPublicKey:e.publicKey,ecdhPrivateKey:A.privateKey};break}case"connected":try{let A=Bt(V.slice(0,4));if(A!==i+1)throw new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number");i=A;let O=await Da(V,l.sharedSecret),N=M[O.id];delete M[O.id],N.resolve(O.result)}catch(A){if(A instanceof xn){let O=M[A.jsonRpcMessageId];delete M[A.jsonRpcMessageId],O.reject(A)}else throw A}break;case"hello_req_sent":{let A=await xa(V,l.associationPublicKey,l.ecdhPrivateKey),O=V.slice(65),N=O.byteLength!==0?await(async()=>{let U=Bt(O.slice(0,4));return U!==i+1?($(new g(T.ERROR_ILLEGAL_TRANSPORT_STATE,"Encrypted message has invalid sequence number")),u.close(),{protocol_version:"v1"}):(i=U,Ma(O,A))})():{protocol_version:"legacy"};l={__type:"connected",sharedSecret:A,sessionProperties:N};let L=Ta(N.protocol_version,async(U,He)=>{let H=o++,Tt=await va({id:H,jsonrpc:"2.0",method:U,params:He??{}},A);return c=="base64"?u.send(ee(Tt)):u.send(Tt),new Promise((It,Ct)=>{M[H]={resolve(Ke){switch(U){case"authorize":case"reauthorize":{let{wallet_uri_base:We}=Ke;if(We!=null)try{Ba(We)}catch(wt){Ct(wt);return}break}}It(Ke)},reject:Ct}})});v=!0;try{w(L)}catch(U){$(U)}break}}};u.addEventListener("message",G),k=()=>{u.removeEventListener("message",G),R(),v||$(new g(T.ERROR_SESSION_CLOSED,"The wallet session was closed before connection.",{closeEvent:new CloseEvent("socket was closed before connection")}))}})}}d();var te="solana:signAndSendTransaction";d();var Ft="solana:signIn";d();var $t="solana:signMessage";d();var ne="solana:signTransaction";d();var Mn="standard:connect";d();var Un="standard:disconnect";d();var Pn="standard:events";var qr=uo($r(),1);var ia="SolanaMobileWalletAdapterDefaultAuthorizationCache";function Ju(){let t;try{t=window.localStorage}catch{}return{async clear(){if(t)try{t.removeItem(ia)}catch{}},async get(){if(t)try{let e=JSON.parse(t.getItem(ia));if(e&&e.accounts){let n=e.accounts.map(a=>({...a,publicKey:"publicKey"in a?new Uint8Array(Object.values(a.publicKey)):wn(a.address)}));return{...e,accounts:n}}else return e||void 0}catch{}},async set(e){if(t)try{t.setItem(ia,JSON.stringify(e))}catch{}}}}function Zu(){return{async select(t){return t.length===1?t[0]:t.includes(yn)?yn:t[0]}}}var Qu=`
<div class="mobile-wallet-adapter-embedded-modal-container" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div data-modal-close style="position: absolute; width: 100%; height: 100%;"></div>
	<div class="mobile-wallet-adapter-embedded-modal-card">
		<div>
			<button data-modal-close class="mobile-wallet-adapter-embedded-modal-close">
				<svg width="14" height="14">
					<path d="M 6.7125,8.3036995 1.9082,13.108199 c -0.2113,0.2112 -0.4765,0.3168 -0.7957,0.3168 -0.3192,0 -0.5844,-0.1056 -0.7958,-0.3168 C 0.1056,12.896899 0,12.631699 0,12.312499 c 0,-0.3192 0.1056,-0.5844 0.3167,-0.7958 L 5.1212,6.7124995 0.3167,1.9082 C 0.1056,1.6969 0,1.4317 0,1.1125 0,0.7933 0.1056,0.5281 0.3167,0.3167 0.5281,0.1056 0.7933,0 1.1125,0 1.4317,0 1.6969,0.1056 1.9082,0.3167 L 6.7125,5.1212 11.5167,0.3167 C 11.7281,0.1056 11.9933,0 12.3125,0 c 0.3192,0 0.5844,0.1056 0.7957,0.3167 0.2112,0.2114 0.3168,0.4766 0.3168,0.7958 0,0.3192 -0.1056,0.5844 -0.3168,0.7957 L 8.3037001,6.7124995 13.1082,11.516699 c 0.2112,0.2114 0.3168,0.4766 0.3168,0.7958 0,0.3192 -0.1056,0.5844 -0.3168,0.7957 -0.2113,0.2112 -0.4765,0.3168 -0.7957,0.3168 -0.3192,0 -0.5844,-0.1056 -0.7958,-0.3168 z" />
				</svg>
			</button>
		</div>
		<div class="mobile-wallet-adapter-embedded-modal-content"></div>
	</div>
</div>
`,eR=`
.mobile-wallet-adapter-embedded-modal-container {
    display: flex; /* Use flexbox to center content */
    justify-content: center; /* Center horizontally */
    align-items: center; /* Center vertically */
    position: fixed; /* Stay in place */
    z-index: 2147483647; /* Sit on top */
    left: 0;
    top: 0;
    width: 100%; /* Full width */
    height: 100%; /* Full height */
    background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
    overflow-y: auto; /* enable scrolling */
}

.mobile-wallet-adapter-embedded-modal-card {
    display: flex;
    flex-direction: column;
    margin: auto 20px;
    max-width: 780px;
    padding: 20px;
    border-radius: 24px;
    background: #ffffff;
    font-family: "Inter Tight", "PT Sans", Calibri, sans-serif;
    transform: translateY(-200%);
    animation: slide-in 0.5s forwards;
}

@keyframes slide-in {
    100% { transform: translateY(0%); }
}

.mobile-wallet-adapter-embedded-modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    cursor: pointer;
    background: #e4e9e9;
    border: none;
    border-radius: 50%;
}

.mobile-wallet-adapter-embedded-modal-close:focus-visible {
    outline-color: red;
}

.mobile-wallet-adapter-embedded-modal-close svg {
    fill: #546266;
    transition: fill 200ms ease 0s;
}

.mobile-wallet-adapter-embedded-modal-close:hover svg {
    fill: #fff;
}
`,tR=`
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
`,y,se,pe,he,Yr,Xr,jr,at,kr,ft=(kr=class{constructor(){_(this,he);_(this,y,null);_(this,se,{});_(this,pe,!1);C(this,"dom",null);C(this,"open",()=>{console.debug("Modal open"),D(this,he,Xr).call(this),s(this,y)&&(s(this,y).style.display="flex")});C(this,"close",(t=void 0)=>{console.debug("Modal close"),D(this,he,jr).call(this),s(this,y)&&(s(this,y).style.display="none"),s(this,se).close?.forEach(e=>e(t))});_(this,at,t=>{t.key==="Escape"&&this.close(t)});this.init=this.init.bind(this),h(this,y,document.getElementById("mobile-wallet-adapter-embedded-root-ui"))}async init(){console.log("Injecting modal"),D(this,he,Yr).call(this)}addEventListener(t,e){return s(this,se)[t]?.push(e)||(s(this,se)[t]=[e]),()=>this.removeEventListener(t,e)}removeEventListener(t,e){s(this,se)[t]=s(this,se)[t]?.filter(n=>e!==n)}},y=new WeakMap,se=new WeakMap,pe=new WeakMap,he=new WeakSet,Yr=function(){if(document.getElementById("mobile-wallet-adapter-embedded-root-ui")){s(this,y)||h(this,y,document.getElementById("mobile-wallet-adapter-embedded-root-ui"));return}h(this,y,document.createElement("div")),s(this,y).id="mobile-wallet-adapter-embedded-root-ui",s(this,y).innerHTML=Qu,s(this,y).style.display="none";let t=s(this,y).querySelector(".mobile-wallet-adapter-embedded-modal-content");t&&(t.innerHTML=this.contentHtml);let e=document.createElement("style");e.id="mobile-wallet-adapter-embedded-modal-styles",e.textContent=eR+this.contentStyles;let n=document.createElement("div");n.innerHTML=tR,this.dom=n.attachShadow({mode:"closed"}),this.dom.appendChild(e),this.dom.appendChild(s(this,y)),document.body.appendChild(n)},Xr=function(){!s(this,y)||s(this,pe)||([...s(this,y).querySelectorAll("[data-modal-close]")].forEach(t=>t?.addEventListener("click",this.close)),window.addEventListener("load",this.close),document.addEventListener("keydown",s(this,at)),h(this,pe,!0))},jr=function(){s(this,pe)&&(window.removeEventListener("load",this.close),document.removeEventListener("keydown",s(this,at)),s(this,y)&&([...s(this,y).querySelectorAll("[data-modal-close]")].forEach(t=>t?.removeEventListener("click",this.close)),h(this,pe,!1)))},at=new WeakMap,kr),nR="To use mobile wallet adapter, you must have a compatible mobile wallet application installed on your device.",aR="This browser appears to be incompatible with mobile wallet adapter. Open this page in a compatible mobile browser app and try again.",rR=class extends ft{constructor(){super(...arguments);C(this,"contentStyles",iR);C(this,"contentHtml",oR)}initWithError(e){super.init(),this.populateError(e)}populateError(e){let n=this.dom?.getElementById("mobile-wallet-adapter-error-message"),a=this.dom?.getElementById("mobile-wallet-adapter-error-action");if(n){if(e.name==="SolanaMobileWalletAdapterError")switch(e.code){case"ERROR_WALLET_NOT_FOUND":n.innerHTML=nR,a&&a.addEventListener("click",()=>{window.location.href="https://solanamobile.com/wallets"});return;case"ERROR_BROWSER_NOT_SUPPORTED":n.innerHTML=aR,a&&(a.style.display="none");return}n.innerHTML=`An unexpected error occurred: ${e.message}`}else console.log("Failed to locate error dialog element")}},oR=`
<svg class="mobile-wallet-adapter-embedded-modal-error-icon" xmlns="http://www.w3.org/2000/svg" height="50px" viewBox="0 -960 960 960" width="50px" fill="#000000"><path d="M 280,-80 Q 197,-80 138.5,-138.5 80,-197 80,-280 80,-363 138.5,-421.5 197,-480 280,-480 q 83,0 141.5,58.5 58.5,58.5 58.5,141.5 0,83 -58.5,141.5 Q 363,-80 280,-80 Z M 824,-120 568,-376 Q 556,-389 542.5,-402.5 529,-416 516,-428 q 38,-24 61,-64 23,-40 23,-88 0,-75 -52.5,-127.5 Q 495,-760 420,-760 345,-760 292.5,-707.5 240,-655 240,-580 q 0,6 0.5,11.5 0.5,5.5 1.5,11.5 -18,2 -39.5,8 -21.5,6 -38.5,14 -2,-11 -3,-22 -1,-11 -1,-23 0,-109 75.5,-184.5 Q 311,-840 420,-840 q 109,0 184.5,75.5 75.5,75.5 75.5,184.5 0,43 -13.5,81.5 Q 653,-460 629,-428 l 251,252 z m -615,-61 71,-71 70,71 29,-28 -71,-71 71,-71 -28,-28 -71,71 -71,-71 -28,28 71,71 -71,71 z"/></svg>
<div class="mobile-wallet-adapter-embedded-modal-title">We can't find a wallet.</div>
<div id="mobile-wallet-adapter-error-message" class="mobile-wallet-adapter-embedded-modal-subtitle"></div>
<div>
    <button data-error-action id="mobile-wallet-adapter-error-action" class="mobile-wallet-adapter-embedded-modal-error-action">
        Find a wallet
    </button>
</div>
`,iR=`
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}

.mobile-wallet-adapter-embedded-modal-error-icon {
    margin-top: 24px;
}

.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}

.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 30px 60px 40px 60px;
    color: #000000;
    font-size: 1.25em;
    font-weight: 400;
}

.mobile-wallet-adapter-embedded-modal-error-action {
    display: block;
    width: 100%;
    height: 56px;
    /*margin-top: 40px;*/
    font-size: 1.25em;
    /*line-height: 24px;*/
    /*letter-spacing: -1%;*/
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}

/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`;async function sR(){if(typeof window<"u"){let t=window.navigator.userAgent.toLowerCase(),e=new rR;t.includes("wv")?e.initWithError({name:"SolanaMobileWalletAdapterError",code:"ERROR_BROWSER_NOT_SUPPORTED",message:""}):e.initWithError({name:"SolanaMobileWalletAdapterError",code:"ERROR_WALLET_NOT_FOUND",message:""}),e.open()}}var Qt,Jr,Vr,cR=(Vr=class extends ft{constructor(){super(...arguments);_(this,Qt);C(this,"contentStyles",dR);C(this,"contentHtml",lR)}initWithCallback(e){super.init(),D(this,Qt,Jr).call(this,e)}},Qt=new WeakSet,Jr=function(e){let n=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),a=async()=>{n?.removeEventListener("click",a),this.close(),e()};n?.addEventListener("click",a)},Vr),lR=`
<svg class="mobile-wallet-adapter-embedded-modal-launch-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21.6 48C7.2 48 0 40.8 0 26.4V21.6C0 7.2 7.2 0 21.6 0H26.4C40.8 0 48 7.2 48 21.6V26.4C48 40.8 40.8 48 26.4 48H21.6Z" fill="#15994E"/>
    <mask id="mask0_189_522" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
        <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
    </mask>
    <g mask="url(#mask0_189_522)">
        <mask id="mask1_189_522" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
            <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
        </mask>
        <g mask="url(#mask1_189_522)">
            <path d="M22.1092 26.1208L19.4498 23.4615C19.1736 23.1851 18.8253 23.0468 18.4048 23.0468C17.9846 23.0468 17.6363 23.1851 17.3598 23.4615C17.0836 23.7377 16.9468 24.0861 16.9495 24.5065C16.9522 24.9267 17.0916 25.275 17.3678 25.5512L21.0405 29.2238C21.3463 29.5276 21.7031 29.6795 22.1108 29.6795C22.5184 29.6795 22.8742 29.5276 23.1782 29.2238L30.5918 21.8098C30.8683 21.5336 31.0065 21.1867 31.0065 20.7692C31.0065 20.3514 30.8683 20.0044 30.5918 19.7282C30.3156 19.4517 29.9673 19.3135 29.5468 19.3135C29.1266 19.3135 28.7784 19.4517 28.5022 19.7282L22.1092 26.1208ZM23.9998 37.6042C22.113 37.6042 20.3425 37.2473 18.6885 36.5335C17.0343 35.8197 15.5954 34.8512 14.3718 33.6278C13.1485 32.4043 12.18 30.9654 11.4662 29.3112C10.7524 27.6572 10.3955 25.8867 10.3955 23.9998C10.3955 22.113 10.7524 20.3425 11.4662 18.6885C12.18 17.0343 13.1485 15.5954 14.3718 14.3718C15.5954 13.1485 17.0343 12.18 18.6885 11.4662C20.3425 10.7524 22.113 10.3955 23.9998 10.3955C25.8867 10.3955 27.6572 10.7524 29.3112 11.4662C30.9654 12.18 32.4043 13.1485 33.6278 14.3718C34.8512 15.5954 35.8197 17.0343 36.5335 18.6885C37.2473 20.3425 37.6042 22.113 37.6042 23.9998C37.6042 25.8867 37.2473 27.6572 36.5335 29.3112C35.8197 30.9654 34.8512 32.4043 33.6278 33.6278C32.4043 34.8512 30.9654 35.8197 29.3112 36.5335C27.6572 37.2473 25.8867 37.6042 23.9998 37.6042Z" fill="white"/>
        </g>
    </g>
</svg>
<div class="mobile-wallet-adapter-embedded-modal-title">Ready to connect!</div>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Connect Wallet
    </button>
</div>
`,dR=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
    min-width: 300px;
}
.mobile-wallet-adapter-embedded-modal-launch-icon {
    margin-top: 24px;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px 30px 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    font-size: 1.25em;
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
}
`,en,Zr,Gr,_R=(Gr=class extends ft{constructor(){super(...arguments);_(this,en);C(this,"contentStyles",RR)}get contentHtml(){let e=mR()?"Long press the app icon on your home screen to open site settings":"Tap the lock or settings icon in the address bar to open site settings";return uR.replace("{{PERMISSION_INSTRUCTION_DETAIL}}",e)}async init(){super.init(),D(this,en,Zr).call(this)}},en=new WeakSet,Zr=function(){let e=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),n=async a=>{e?.removeEventListener("click",n),this.close(a)};e?.addEventListener("click",n)},Gr),uR=`
<div class="mobile-wallet-adapter-embedded-modal-header">
    Local Wallet Connection
</div>
<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21.6 48C7.2 48 0 40.8 0 26.4V21.6C0 7.2 7.2 0 21.6 0H26.4C40.8 0 48 7.2 48 21.6V26.4C48 40.8 40.8 48 26.4 48H21.6Z" fill="#ED1515"/>
    <mask id="mask0_147_1364" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="8" y="8" width="32" height="32">
        <rect x="8" y="8" width="32" height="32" fill="#D9D9D9"/>
    </mask>
    <g mask="url(#mask0_147_1364)">
        <path d="M20.1398 36.2705C19.7363 36.2705 19.3508 36.1945 18.9835 36.0425C18.6162 35.8907 18.2916 35.674 18.0098 35.3922L12.6072 29.9895C12.3254 29.7077 12.1086 29.3832 11.9568 29.0158C11.8048 28.6485 11.7288 28.2631 11.7288 27.8595V20.1395C11.7288 19.736 11.8048 19.3505 11.9568 18.9832C12.1086 18.6158 12.3254 18.2913 12.6072 18.0095L18.0098 12.6068C18.2916 12.3251 18.6162 12.1083 18.9835 11.9565C19.3508 11.8045 19.7363 11.7285 20.1398 11.7285H27.8598C28.2634 11.7285 28.6488 11.8045 29.0162 11.9565C29.3835 12.1083 29.708 12.3251 29.9898 12.6068L35.3925 18.0095C35.6743 18.2913 35.891 18.6158 36.0428 18.9832C36.1948 19.3505 36.2708 19.736 36.2708 20.1395V27.8595C36.2708 28.2631 36.1948 28.6485 36.0428 29.0158C35.891 29.3832 35.6743 29.7077 35.3925 29.9895L29.9898 35.3922C29.708 35.674 29.3835 35.8907 29.0162 36.0425C28.6488 36.1945 28.2634 36.2705 27.8598 36.2705H20.1398ZM20.1732 33.2372H27.8265L33.2375 27.8262V20.1728L27.8265 14.7618H20.1732L14.7622 20.1728V27.8262L20.1732 33.2372ZM23.9998 25.9538L26.7868 28.7408C27.0473 29.0013 27.3729 29.1302 27.7638 29.1275C28.1549 29.1248 28.4807 28.9933 28.7412 28.7328C29.0016 28.4724 29.1318 28.1466 29.1318 27.7555C29.1318 27.3646 29.0016 27.039 28.7412 26.7785L25.9542 23.9995L28.7412 21.2125C29.0016 20.9521 29.1318 20.6264 29.1318 20.2355C29.1318 19.8444 29.0016 19.5186 28.7412 19.2582C28.4807 18.9977 28.1549 18.8675 27.7638 18.8675C27.3729 18.8675 27.0473 18.9977 26.7868 19.2582L23.9998 22.0452L21.2128 19.2582C20.9524 18.9977 20.628 18.8675 20.2398 18.8675C19.8514 18.8675 19.5269 18.9977 19.2665 19.2582C19.006 19.5186 18.8758 19.8444 18.8758 20.2355C18.8758 20.6264 19.006 20.9521 19.2665 21.2125L22.0455 23.9995L19.2585 26.7865C18.998 27.047 18.8692 27.3713 18.8718 27.7595C18.8745 28.148 19.006 28.4724 19.2665 28.7328C19.5269 28.9933 19.8527 29.1235 20.2438 29.1235C20.6347 29.1235 20.9604 28.9933 21.2208 28.7328L23.9998 25.9538Z" fill="black"/>
    </g>
</svg>
<div class="mobile-wallet-adapter-embedded-modal-title">
    Your wallet connection is blocked
</div>
<div id="mobile-wallet-adapter-local-launch-message" class="mobile-wallet-adapter-embedded-modal-subtitle">
    Visit site settings in the address bar and allow "Apps on Device".
</div>

<div class="mobile-wallet-adapter-embedded-modal-divider"><hr></div>
<div class="mobile-wallet-adapter-embedded-modal-footer">
    <div class="mobile-wallet-adapter-embedded-modal-details">
        <!-- Clickable header (label associated with the checkbox) -->
      	<label for="collapsible-1" class="mobile-wallet-adapter-embedded-modal-details-collapsible-header">
            <!-- Hidden checkbox to track state -->
            <input type="checkbox" id="collapsible-1" class="mobile-wallet-adapter-embedded-modal-details-collapsible-input">
            <span class="mobile-wallet-adapter-embedded-modal-details-collapsible-header-label">
              See details
            </span>
            <svg class="mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <mask id="mask0_147_1382" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="#D9D9D9"/>
              </mask>
              <g mask="url(#mask0_147_1382)">
                <path d="M11.9999 17.0811C11.8506 17.0811 11.7087 17.0563 11.5741 17.0067C11.4395 16.957 11.3162 16.8762 11.2042 16.7643L6.57924 12.1393C6.36801 11.9281 6.26656 11.667 6.27489 11.3561C6.28322 11.0453 6.39301 10.7842 6.60424 10.573C6.81547 10.3618 7.08069 10.2561 7.39989 10.2561C7.71909 10.2561 7.9843 10.3618 8.19554 10.573L11.9999 14.3773L15.8292 10.548C16.0405 10.3368 16.3015 10.2353 16.6124 10.2436C16.9233 10.252 17.1843 10.3618 17.3955 10.573C17.6068 10.7842 17.7124 11.0494 17.7124 11.3686C17.7124 11.6878 17.6068 11.9531 17.3955 12.1643L12.7955 16.7643C12.6836 16.8762 12.5603 16.957 12.4257 17.0067C12.2911 17.0563 12.1492 17.0811 11.9999 17.0811Z" fill="black"/>
              </g>
            </svg>
      	</label>
        
        <!-- Content to show/hide -->
        <ul class="mobile-wallet-adapter-embedded-modal-details-collapsible-content">
            <li>{{PERMISSION_INSTRUCTION_DETAIL}}</li>
            <li>Allow "Apps on Device"</li>
        </ul>
    </div>
</div>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Got it
    </button>
</div>
`,RR=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}
.mobile-wallet-adapter-embedded-modal-header {
    margin: 18px auto 30px auto;
    color: #7D9093;
    font-size: 1.0em;
    font-weight: 500;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 12px 60px 30px 60px;
    color: #7D9093;
    font-size: 1.25em;
    font-weight: 400;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header {
    display: flex;
    flex-direction: row;
  	justify-content: space-between;
    margin: 10px auto 10px auto;
    color: #000000;
    font-size: 1.5em;
    font-weight: 600;
    cursor: pointer; /* Show pointer on hover */
    transition: background 0.2s ease; /* Smooth background change */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon {
  	transition: rotate 0.3s ease;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-input {
  	display: none; /* Hide the checkbox */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-content {
    margin: 0px auto 40px auto;
    max-height: 0px; /* Collapse content */
    overflow: hidden; /* Hide overflow when collapsed */
    transition: max-height 0.3s ease; /* Smooth transition */
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-content li {
    margin: 20px auto;
    color: #000000;
    font-size: 1.25em;
    font-weight: 400;
    text-align: left;
}
/* When checkbox is checked, show content */
.mobile-wallet-adapter-embedded-modal-details-collapsible-header:has(> input:checked) ~ .mobile-wallet-adapter-embedded-modal-details-collapsible-content {
  	max-height: 300px;
}
.mobile-wallet-adapter-embedded-modal-details-collapsible-header:has(> input:checked) > .mobile-wallet-adapter-embedded-modal-details-collapsible-header-icon {
  	rotate: 180deg;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    /*margin-top: 40px;*/
    font-size: 1.25em;
    /*line-height: 24px;*/
    /*letter-spacing: -1%;*/
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.75em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`,tn,Qr,zr,ER=(zr=class extends ft{constructor(){super(...arguments);_(this,tn);C(this,"contentStyles",AR);C(this,"contentHtml",hR)}async init(){super.init(),D(this,tn,Qr).call(this)}},tn=new WeakSet,Qr=function(){let e=this.dom?.getElementById("mobile-wallet-adapter-launch-action"),n=async()=>{e?.removeEventListener("click",n);try{await fetch("http://localhost")}catch{}this.close()};e?.addEventListener("click",n)},zr),hR=`
<div class="mobile-wallet-adapter-embedded-modal-title">Allow connections to your wallet</div>
<div id="mobile-wallet-adapter-local-launch-message" class="mobile-wallet-adapter-embedded-modal-subtitle">
    Tap "Allow" on the next screen
</div>
<svg class="mobile-wallet-adapter-embedded-modal-permission-prompt-mock" xmlns="http://www.w3.org/2000/svg" width="281" height="83" viewBox="0 0 281 83" fill="none">
    <rect width="281" height="83" rx="22" fill="#F0F3F5"/>
    <path d="M254.194 64L252.626 56.657H254.047L254.866 61.452L254.985 62.278H255.02L255.146 61.452L255.993 57.497H257.4L258.254 61.431L258.373 62.278H258.415L258.534 61.431L259.346 56.657H260.718L259.143 64H257.673L256.826 59.961L256.693 59.093H256.651L256.511 59.961L255.664 64H254.194Z" fill="black"/>
    <path d="M248.837 64.231C248.147 64.231 247.54 64.07 247.017 63.748C246.495 63.426 246.086 62.978 245.792 62.404C245.498 61.83 245.351 61.1673 245.351 60.416V60.241C245.351 59.4897 245.498 58.827 245.792 58.253C246.086 57.679 246.495 57.2333 247.017 56.916C247.54 56.594 248.147 56.433 248.837 56.433C249.528 56.433 250.135 56.594 250.657 56.916C251.18 57.2333 251.588 57.679 251.882 58.253C252.176 58.827 252.323 59.4897 252.323 60.241V60.416C252.323 61.1673 252.176 61.83 251.882 62.404C251.588 62.978 251.18 63.426 250.657 63.748C250.135 64.07 249.528 64.231 248.837 64.231ZM248.837 62.824C249.43 62.824 249.897 62.607 250.237 62.173C250.583 61.7343 250.755 61.1417 250.755 60.395V60.262C250.755 59.5107 250.583 58.918 250.237 58.484C249.897 58.05 249.43 57.833 248.837 57.833C248.249 57.833 247.783 58.05 247.437 58.484C247.092 58.918 246.919 59.5107 246.919 60.262V60.395C246.919 61.1417 247.092 61.7343 247.437 62.173C247.783 62.607 248.249 62.824 248.837 62.824Z" fill="black"/>
    <path d="M242.298 64.231C241.467 64.231 240.814 63.993 240.338 63.517C239.866 63.0364 239.631 62.3737 239.631 61.529V53.78H241.178V61.389C241.178 62.3317 241.591 62.803 242.417 62.803C242.65 62.803 242.865 62.7587 243.061 62.67C243.257 62.5814 243.464 62.4367 243.684 62.236L244.538 63.377C244.225 63.6664 243.884 63.881 243.516 64.021C243.152 64.161 242.746 64.231 242.298 64.231ZM237.51 55.061V53.78H240.611V55.061H237.51Z" fill="black"/>
    <path d="M234.463 64.231C233.633 64.231 232.979 63.993 232.503 63.517C232.032 63.0364 231.796 62.3737 231.796 61.529V53.78H233.343V61.389C233.343 62.3317 233.756 62.803 234.582 62.803C234.816 62.803 235.03 62.7587 235.226 62.67C235.422 62.5814 235.63 62.4367 235.849 62.236L236.703 63.377C236.391 63.6664 236.05 63.881 235.681 64.021C235.317 64.161 234.911 64.231 234.463 64.231ZM229.675 55.061V53.78H232.776V55.061H229.675Z" fill="black"/>
    <path d="M221.442 64L224.557 53.976H226.132L229.233 64H227.581L225.642 56.972L225.341 55.761H225.299L225.005 56.972L223.073 64H221.442ZM222.835 61.634L223.255 60.29H227.371L227.805 61.634H222.835Z" fill="black"/>
    <path d="M178.261 64L175.034 60.066V60.024L178.121 56.657H180.011L176.504 60.423V59.632L180.165 64H178.261ZM173.543 64V53.78H175.097V64H173.543Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M169.306 64.224C168.588 64.224 167.958 64.0653 167.416 63.748C166.88 63.426 166.462 62.9803 166.163 62.411C165.865 61.837 165.715 61.1673 165.715 60.402V60.248C165.715 59.4873 165.862 58.8223 166.156 58.253C166.45 57.679 166.863 57.2333 167.395 56.916C167.927 56.594 168.546 56.433 169.25 56.433C169.978 56.433 170.59 56.6056 171.084 56.951C171.579 57.2917 171.955 57.777 172.211 58.407L170.874 58.995C170.72 58.6123 170.508 58.323 170.237 58.127C169.967 57.9263 169.633 57.826 169.236 57.826C168.63 57.826 168.149 58.0383 167.794 58.463C167.444 58.883 167.269 59.4616 167.269 60.199V60.465C167.269 61.1837 167.454 61.7577 167.822 62.187C168.196 62.6163 168.69 62.831 169.306 62.831C169.712 62.831 170.06 62.733 170.349 62.537C170.639 62.341 170.877 62.0423 171.063 61.641L172.379 62.285C172.188 62.6957 171.941 63.0457 171.637 63.335C171.334 63.6243 170.986 63.846 170.594 64C170.202 64.1493 169.773 64.224 169.306 64.224Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M161.003 64.231C160.312 64.231 159.706 64.07 159.183 63.748C158.66 63.426 158.252 62.978 157.958 62.404C157.664 61.83 157.517 61.1673 157.517 60.416V60.241C157.517 59.4897 157.664 58.827 157.958 58.253C158.252 57.679 158.66 57.2333 159.183 56.916C159.706 56.594 160.312 56.433 161.003 56.433C161.694 56.433 162.3 56.594 162.823 56.916C163.346 57.2333 163.754 57.679 164.048 58.253C164.342 58.827 164.489 59.4897 164.489 60.241V60.416C164.489 61.1673 164.342 61.83 164.048 62.404C163.754 62.978 163.346 63.426 162.823 63.748C162.3 64.07 161.694 64.231 161.003 64.231ZM161.003 62.824C161.596 62.824 162.062 62.607 162.403 62.173C162.748 61.7343 162.921 61.1417 162.921 60.395V60.262C162.921 59.5107 162.748 58.918 162.403 58.484C162.062 58.05 161.596 57.833 161.003 57.833C160.415 57.833 159.948 58.05 159.603 58.484C159.258 58.918 159.085 59.5107 159.085 60.262V60.395C159.085 61.1417 159.258 61.7343 159.603 62.173C159.948 62.607 160.415 62.824 161.003 62.824Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M154.463 64.231C153.633 64.231 152.979 63.993 152.503 63.517C152.032 63.0364 151.796 62.3737 151.796 61.529V53.78H153.343V61.389C153.343 62.3317 153.756 62.803 154.582 62.803C154.816 62.803 155.03 62.7587 155.226 62.67C155.422 62.5814 155.63 62.4367 155.849 62.236L156.703 63.377C156.391 63.6664 156.05 63.881 155.681 64.021C155.317 64.161 154.911 64.231 154.463 64.231ZM149.675 55.061V53.78H152.776V55.061H149.675Z" fill="#7D9093" fill-opacity="0.5"/>
    <path d="M142.24 64V53.976H145.544C146.421 53.976 147.112 54.1953 147.616 54.634C148.12 55.0726 148.372 55.6583 148.372 56.391V56.566C148.372 57.0886 148.246 57.5366 147.994 57.91C147.742 58.2833 147.38 58.5586 146.909 58.736V58.792C147.492 58.9226 147.947 59.2003 148.274 59.625C148.605 60.045 148.771 60.5606 148.771 61.172V61.361C148.771 61.893 148.645 62.3573 148.393 62.754C148.145 63.1506 147.795 63.4586 147.343 63.678C146.895 63.8926 146.365 64 145.754 64H142.24ZM143.794 62.656H145.572C146.085 62.656 146.482 62.5253 146.762 62.264C147.042 62.0026 147.182 61.6293 147.182 61.144V60.99C147.182 60.5046 147.037 60.1313 146.748 59.87C146.463 59.604 146.05 59.471 145.509 59.471H143.36V58.183H145.32C145.791 58.183 146.153 58.064 146.405 57.826C146.657 57.588 146.783 57.2496 146.783 56.811V56.685C146.783 56.2416 146.657 55.9033 146.405 55.67C146.157 55.4366 145.796 55.32 145.32 55.32H143.794V62.656Z" fill="#7D9093" fill-opacity="0.5"/>
    <rect x="18" y="17" width="246" height="7" rx="3.5" fill="#7D9093" fill-opacity="0.26"/>
    <rect x="18" y="33" width="82" height="7" rx="3.5" fill="#7D9093" fill-opacity="0.26"/>
</svg>
<div>
    <button data-modal-action id="mobile-wallet-adapter-launch-action" class="mobile-wallet-adapter-embedded-modal-launch-action">
        Continue to Allow
    </button>
</div>
`,AR=`
.mobile-wallet-adapter-embedded-modal-close {
    display: none;
}
.mobile-wallet-adapter-embedded-modal-content {
    text-align: center;
}
.mobile-wallet-adapter-embedded-modal-title {
    margin: 18px 100px auto 100px;
    color: #000000;
    font-size: 2.75em;
    font-weight: 600;
}
.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: 20px 60px 40px 60px;
    color: #7D9093;
    font-size: 1.25em;
    font-weight: 400;
}
.mobile-wallet-adapter-embedded-modal-permission-prompt-mock {
    width: 90%;
    height: auto;
    margin: 0 auto 30px auto;
    display: block;
}
.mobile-wallet-adapter-embedded-modal-launch-action {
    display: block;
    width: 100%;
    height: 56px;
    font-size: 1.25em;
    background: #000000;
    color: #FFFFFF;
    border-radius: 18px;
}
/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
        margin-right: 12px;
        margin-left: 12px;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: 12px;
        margin-left: 12px;
    }
}
`;function OR(){return typeof window<"u"&&window.isSecureContext&&typeof document<"u"&&/android/i.test(navigator.userAgent)}function NR(){return typeof window<"u"&&window.isSecureContext&&typeof document<"u"&&!/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)}function SR(t){return/(WebView|Version\/.+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)|; wv\).+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))/i.test(t)}function eo(t){return t.includes("Solana Mobile Web Shell")}function mR(){let t=typeof document<"u"&&document.referrer.startsWith("android-app://");if(typeof window>"u")return t;let e=window.matchMedia("(display-mode: standalone)").matches,n=window.matchMedia("(display-mode: fullscreen)").matches,a=window.matchMedia("(display-mode: minimal-ui)").matches;return t||e||n||a}async function to(){if(!(typeof navigator<"u"&&eo(navigator.userAgent)))try{let t=await navigator.permissions.query({name:"loopback-network"});if(t.state==="granted")return;if(t.state==="denied"){let e=new _R;throw e.init(),e.open(),new g(T.ERROR_LOOPBACK_ACCESS_BLOCKED,"Local Network Access permission denied")}else if(t.state==="prompt"){let e=new ER;if(await new Promise((n,a)=>{e.addEventListener("close",r=>{r&&a(new g(T.ERROR_ASSOCIATION_CANCELLED,"Wallet connection cancelled by user",{event:r}))}),t.onchange=()=>{t.onchange=null,n(t.state)},e.init(),e.open()})==="granted"){let n=new cR;await new Promise((a,r)=>{n.addEventListener("close",o=>{o&&r(new g(T.ERROR_ASSOCIATION_CANCELLED,"Wallet connection cancelled by user",{event:o}))}),n.initWithCallback(async()=>{a(!0)}),n.open()});return}else return await to()}throw new g(T.ERROR_LOOPBACK_ACCESS_BLOCKED,"Local Network Access permission unknown")}catch(t){if(t instanceof TypeError&&(t.message.includes("loopback-network")||t.message.includes("local-network-access")))return;throw t instanceof g?t:new g(T.ERROR_LOOPBACK_ACCESS_BLOCKED,t instanceof Error?t.message:"Local Network Access permission unknown")}}var pR=`
<div class="mobile-wallet-adapter-embedded-loading-indicator" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div data-modal-close style="position: absolute; width: 100%; height: 100%;"></div>
    <div class="mobile-wallet-adapter-embedded-loading-container">
        <div class="mobile-wallet-adapter-embedded-loading-animation"></div>
    </div>
</div>
`,gR=`
.mobile-wallet-adapter-embedded-loading-indicator {
    display: flex; /* Use flexbox to center content */
    justify-content: center; /* Center horizontally */
    align-items: start; /* Center vertically */
    position: fixed; /* Stay in place */
    z-index: 1; /* Sit on top */
    left: 0;
    top: 0;
    width: 100%; /* Full width */
    height: 100%; /* Full height */
    background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
    overflow-y: auto; /* enable scrolling */
}

.mobile-wallet-adapter-embedded-loading-container {
    display: flex;
    margin: auto;
}

.mobile-wallet-adapter-embedded-loading-animation {
    position: relative;
    left: -9999px;
    width: 10px;
    height: 10px;
    border-radius: 5px;
    background-color: var(--spinner-color);
    color: var(--spinner-color);
    box-shadow: 9984px 0 0 0 var(--spinner-color), 
                9999px 0 0 0 var(--spinner-color), 
                10014px 0 0 0 var(--spinner-color);
    animation: dot-typing 1.5s infinite linear;
}

@keyframes dot-typing {
    0% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    16.667% {
        box-shadow: 9984px -10px 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    33.333% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    50% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px -10px 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    66.667% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
    83.333% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px -10px 0 0 var(--spinner-color);
    }
    100% {
        box-shadow: 9984px 0 0 0 var(--spinner-color), 
                    9999px 0 0 0 var(--spinner-color), 
                    10014px 0 0 0 var(--spinner-color);
    }
}
`,P,ce,ge,Ae,no,ao,ro,rt,Hr,fR=(Hr=class{constructor(){_(this,Ae);_(this,P,null);_(this,ce,{});_(this,ge,!1);C(this,"dom",null);C(this,"open",()=>{console.debug("Modal open"),D(this,Ae,ao).call(this),s(this,P)&&(s(this,P).style.display="flex")});C(this,"close",(t=void 0)=>{console.debug("Modal close"),D(this,Ae,ro).call(this),s(this,P)&&(s(this,P).style.display="none"),s(this,ce).close?.forEach(e=>e(t))});_(this,rt,t=>{t.key==="Escape"&&this.close(t)});this.init=this.init.bind(this),h(this,P,document.getElementById("mobile-wallet-adapter-embedded-root-ui"))}async init(){console.log("Injecting modal"),D(this,Ae,no).call(this)}addEventListener(t,e){return s(this,ce)[t]?.push(e)||(s(this,ce)[t]=[e]),()=>this.removeEventListener(t,e)}removeEventListener(t,e){s(this,ce)[t]=s(this,ce)[t]?.filter(n=>e!==n)}},P=new WeakMap,ce=new WeakMap,ge=new WeakMap,Ae=new WeakSet,no=function(){if(this.dom)return;h(this,P,document.createElement("div")),s(this,P).id="mobile-wallet-adapter-embedded-root-ui",s(this,P).innerHTML=pR,s(this,P).style.display="none";let t=document.createElement("style");t.id="mobile-wallet-adapter-embedded-modal-styles",t.textContent=gR;let e=document.createElement("div");this.dom=e.attachShadow({mode:"closed"}),e.style.setProperty("--spinner-color","#FFFFFF"),this.dom.appendChild(t),this.dom.appendChild(s(this,P)),document.body.appendChild(e)},ao=function(){!s(this,P)||s(this,ge)||([...s(this,P).querySelectorAll("[data-modal-close]")].forEach(t=>t?.addEventListener("click",e=>{this.close(e)})),window.addEventListener("load",this.close),document.addEventListener("keydown",s(this,rt)),h(this,ge,!0))},ro=function(){s(this,ge)&&(window.removeEventListener("load",this.close),document.removeEventListener("keydown",s(this,rt)),s(this,P)&&([...s(this,P).querySelectorAll("[data-modal-close]")].forEach(t=>t?.removeEventListener("click",this.close)),h(this,ge,!1)))},rt=new WeakMap,Hr),TR=class extends ft{constructor(){super(...arguments);C(this,"contentStyles",CR);C(this,"contentHtml",IR)}async initWithQR(e){super.init(),this.populateQRCode(e)}async populateQRCode(e){let n=this.dom?.getElementById("mobile-wallet-adapter-embedded-modal-qr-code-container");if(n){let a=await qr.default.toCanvas(e,{width:200,margin:0});n.firstElementChild!==null?n.replaceChild(a,n.firstElementChild):n.appendChild(a);let r=this.dom?.getElementById("mobile-wallet-adapter-embedded-modal-qr-placeholder");r&&(r.style.display="none")}else console.error("QRCode Container not found")}},IR=`
<div class="mobile-wallet-adapter-embedded-modal-qr-content">
    <div>
        <svg class="mobile-wallet-adapter-embedded-modal-icon" width="100%" height="100%">
            <circle r="52" cx="53" cy="53" fill="#99b3be" stroke="#000000" stroke-width="2"/>
            <path d="m 53,82.7305 c -3.3116,0 -6.1361,-1.169 -8.4735,-3.507 -2.338,-2.338 -3.507,-5.1625 -3.507,-8.4735 0,-3.3116 1.169,-6.1364 3.507,-8.4744 2.3374,-2.338 5.1619,-3.507 8.4735,-3.507 3.3116,0 6.1361,1.169 8.4735,3.507 2.338,2.338 3.507,5.1628 3.507,8.4744 0,3.311 -1.169,6.1355 -3.507,8.4735 -2.3374,2.338 -5.1619,3.507 -8.4735,3.507 z m 0.007,-5.25 c 1.8532,0 3.437,-0.6598 4.7512,-1.9793 1.3149,-1.3195 1.9723,-2.9058 1.9723,-4.7591 0,-1.8526 -0.6598,-3.4364 -1.9793,-4.7512 -1.3195,-1.3149 -2.9055,-1.9723 -4.7582,-1.9723 -1.8533,0 -3.437,0.6598 -4.7513,1.9793 -1.3148,1.3195 -1.9722,2.9058 -1.9722,4.7591 0,1.8527 0.6597,3.4364 1.9792,4.7512 1.3195,1.3149 2.9056,1.9723 4.7583,1.9723 z m -28,-33.5729 -3.85,-3.6347 c 4.1195,-4.025 8.8792,-7.1984 14.2791,-9.52 5.4005,-2.3223 11.2551,-3.4834 17.5639,-3.4834 6.3087,0 12.1634,1.1611 17.5639,3.4834 5.3999,2.3216 10.1596,5.495 14.2791,9.52 l -3.85,3.6347 C 77.2999,40.358 73.0684,37.5726 68.2985,35.5514 63.5292,33.5301 58.4296,32.5195 53,32.5195 c -5.4297,0 -10.5292,1.0106 -15.2985,3.0319 -4.7699,2.0212 -9.0014,4.8066 -12.6945,8.3562 z m 44.625,10.8771 c -2.2709,-2.1046 -4.7962,-3.7167 -7.5758,-4.8361 -2.7795,-1.12 -5.7983,-1.68 -9.0562,-1.68 -3.2579,0 -6.2621,0.56 -9.0125,1.68 -2.7504,1.1194 -5.2903,2.7315 -7.6195,4.8361 L 32.5189,51.15 c 2.8355,-2.6028 5.9777,-4.6086 9.4263,-6.0174 3.4481,-1.4087 7.133,-2.1131 11.0548,-2.1131 3.9217,0 7.5979,0.7044 11.0285,2.1131 3.43,1.4088 6.5631,3.4146 9.3992,6.0174 z"/>
        </svg>
        <div class="mobile-wallet-adapter-embedded-modal-title">Remote Mobile Wallet Adapter</div>
    </div>
    <div>
        <div>
            <h4 class="mobile-wallet-adapter-embedded-modal-qr-label">
                Open your wallet and scan this code
            </h4>
        </div>
        <div id="mobile-wallet-adapter-embedded-modal-qr-code-container" class="mobile-wallet-adapter-embedded-modal-qr-code-container">
            <div id="mobile-wallet-adapter-embedded-modal-qr-placeholder" class="mobile-wallet-adapter-embedded-modal-qr-placeholder"></div>
        </div>
    </div>
</div>
<div class="mobile-wallet-adapter-embedded-modal-divider"><hr></div>
<div class="mobile-wallet-adapter-embedded-modal-footer">
    <div class="mobile-wallet-adapter-embedded-modal-subtitle">
        Follow the instructions on your device. When you're finished, this screen will update.
    </div>
    <div class="mobile-wallet-adapter-embedded-modal-progress-badge">
        <div>
            <div class="spinner">
                <div class="leftWrapper">
                    <div class="left">
                        <div class="circle"></div>
                    </div>
                </div>
                <div class="rightWrapper">
                    <div class="right">
                        <div class="circle"></div>
                    </div>
                </div>
            </div>
        </div>
        <div>Waiting for scan</div>
    </div>
</div>
`,CR=`
.mobile-wallet-adapter-embedded-modal-qr-content {
    display: flex; 
    margin-top: 10px;
    padding: 10px;
}

.mobile-wallet-adapter-embedded-modal-qr-content > div:first-child {
    display: flex;
    flex-direction: column;
    flex: 2;
    margin-top: auto;
    margin-right: 30px;
}

.mobile-wallet-adapter-embedded-modal-qr-content > div:nth-child(2) {
    display: flex;
    flex-direction: column;
    flex: 1;
    margin-left: auto;
}

.mobile-wallet-adapter-embedded-modal-footer {
    display: flex;
    padding: 10px;
}

.mobile-wallet-adapter-embedded-modal-icon {}

.mobile-wallet-adapter-embedded-modal-title {
    color: #000000;
    font-size: 2.5em;
    font-weight: 600;
}

.mobile-wallet-adapter-embedded-modal-qr-label {
    text-align: right;
    color: #000000;
}

.mobile-wallet-adapter-embedded-modal-qr-code-container {
    margin-left: auto;
}

.mobile-wallet-adapter-embedded-modal-qr-placeholder {
    margin-left: auto;
    min-width: 200px;
    min-height: 200px;
    background: linear-gradient(-60deg, #F7F8F8 30%, #ECEEEE 50%, #F7F8F8 70%);
    background-size: 200%;
    animation: placeholderAnimate 2.7s linear infinite;
    border-radius: 12px;
}

.mobile-wallet-adapter-embedded-modal-divider {
    margin-top: 20px;
    padding-left: 10px;
    padding-right: 10px;
}

.mobile-wallet-adapter-embedded-modal-divider hr {
    border-top: 1px solid #D9DEDE;
}

.mobile-wallet-adapter-embedded-modal-subtitle {
    margin: auto;
    margin-right: 60px;
    padding: 20px;
    color: #6E8286;
}

.mobile-wallet-adapter-embedded-modal-progress-badge {
    display: flex;
    background: #F7F8F8;
    height: 56px;
    min-width: 200px;
    margin: auto;
    padding-left: 20px;
    padding-right: 20px;
    border-radius: 18px;
    color: #A8B6B8;
    align-items: center;
}

.mobile-wallet-adapter-embedded-modal-progress-badge > div:first-child {
    margin-left: auto;
    margin-right: 20px;
}

.mobile-wallet-adapter-embedded-modal-progress-badge > div:nth-child(2) {
    margin-right: auto;
}

/* Smaller screens */
@media all and (max-width: 600px) {
    .mobile-wallet-adapter-embedded-modal-card {
        text-align: center;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content {
        flex-direction: column;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content > div:first-child {
        margin: auto;
    }
    .mobile-wallet-adapter-embedded-modal-qr-content > div:nth-child(2) {
        margin: auto;
        flex: 2 auto;
    }
    .mobile-wallet-adapter-embedded-modal-footer {
        flex-direction: column;
    }
    .mobile-wallet-adapter-embedded-modal-icon {
        display: none;
    }
    .mobile-wallet-adapter-embedded-modal-title {
        font-size: 1.5em;
    }
    .mobile-wallet-adapter-embedded-modal-subtitle {
        margin-right: unset;
    }
    .mobile-wallet-adapter-embedded-modal-qr-label {
        text-align: center;
    }
    .mobile-wallet-adapter-embedded-modal-qr-code-container {
        margin: auto;
    }
    .mobile-wallet-adapter-embedded-modal-qr-placeholder {
        margin: auto;
    }
}

/* QR Placeholder */
@keyframes placeholderAnimate {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* Spinner */
@keyframes spinLeft {
    0% {
        transform: rotate(20deg);
    }
    50% {
        transform: rotate(160deg);
    }
    100% {
        transform: rotate(20deg);
    }
}
@keyframes spinRight {
    0% {
        transform: rotate(160deg);
    }
    50% {
        transform: rotate(20deg);
    }
    100% {
        transform: rotate(160deg);
    }
}
@keyframes spin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(2520deg);
    }
}

.spinner {
    position: relative;
    width: 1.5em;
    height: 1.5em;
    margin: auto;
    animation: spin 10s linear infinite;
}
.spinner::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
}
.right, .rightWrapper, .left, .leftWrapper {
    position: absolute;
    top: 0;
    overflow: hidden;
    width: .75em;
    height: 1.5em;
}
.left, .leftWrapper {
    left: 0;
}
.right {
    left: -12px;
}
.rightWrapper {
    right: 0;
}
.circle {
    border: .125em solid #A8B6B8;
    width: 1.25em; /* 1.5em - 2*0.125em border */
    height: 1.25em; /* 1.5em - 2*0.125em border */
    border-radius: 0.75em; /* 0.5*1.5em spinner size 8 */
}
.left {
    transform-origin: 100% 50%;
    animation: spinLeft 2.5s cubic-bezier(.2,0,.8,1) infinite;
}
.right {
    transform-origin: 100% 50%;
    animation: spinRight 2.5s cubic-bezier(.2,0,.8,1) infinite;
}
`,oo="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik03IDIuNUgxN0MxNy44Mjg0IDIuNSAxOC41IDMuMTcxNTcgMTguNSA0VjIwQzE4LjUgMjAuODI4NCAxNy44Mjg0IDIxLjUgMTcgMjEuNUg3QzYuMTcxNTcgMjEuNSA1LjUgMjAuODI4NCA1LjUgMjBWNEM1LjUgMy4xNzE1NyA2LjE3MTU3IDIuNSA3IDIuNVpNMyA0QzMgMS43OTA4NiA0Ljc5MDg2IDAgNyAwSDE3QzE5LjIwOTEgMCAyMSAxLjc5MDg2IDIxIDRWMjBDMjEgMjIuMjA5MSAxOS4yMDkxIDI0IDE3IDI0SDdDNC43OTA4NiAyNCAzIDIyLjIwOTEgMyAyMFY0Wk0xMSA0LjYxNTM4QzEwLjQ0NzcgNC42MTUzOCAxMCA1LjA2MzEgMTAgNS42MTUzOFY2LjM4NDYyQzEwIDYuOTM2OSAxMC40NDc3IDcuMzg0NjIgMTEgNy4zODQ2MkgxM0MxMy41NTIzIDcuMzg0NjIgMTQgNi45MzY5IDE0IDYuMzg0NjJWNS42MTUzOEMxNCA1LjA2MzEgMTMuNTUyMyA0LjYxNTM4IDEzIDQuNjE1MzhIMTFaIiBmaWxsPSIjRENCOEZGIi8+Cjwvc3ZnPgo=",wR="Mobile Wallet Adapter",LR="Remote Mobile Wallet Adapter",io=64,so=[te,ne,$t,Ft],bR=3e4;function z(t){return t instanceof Error?t.message:"Unknown error"}var le,nn,an,rn,on,xe,B,X,J,Me,de,ot,Ue,it,sn,Re,Jt,co,cn,st,fe,ct,Pe,lt,Te,Be,dt,ln,dn,_t,ut,_n,un,Rt,Kr,yR=(Kr=class{constructor(t){_(this,Re);_(this,le,{});_(this,nn,"1.0.0");_(this,an,wR);_(this,rn,"https://solanamobile.com/wallets");_(this,on,oo);_(this,xe);_(this,B);_(this,X);_(this,J,!1);_(this,Me,0);_(this,de,[]);_(this,ot);_(this,Ue);_(this,it);_(this,sn,(t,e)=>(s(this,le)[t]?.push(e)||(s(this,le)[t]=[e]),()=>D(this,Re,co).call(this,t,e)));_(this,cn,async({silent:t}={})=>{if(s(this,J)||this.connected)return{accounts:this.accounts};h(this,J,!0);try{if(t){let e=await s(this,X).get();if(e)await s(this,ct).call(this,e.capabilities),await s(this,fe).call(this,e);else return{accounts:this.accounts}}else await s(this,st).call(this)}catch(e){throw new Error(z(e),{cause:e})}finally{h(this,J,!1)}return{accounts:this.accounts}});_(this,st,async t=>{try{let e=await s(this,X).get();if(e)return s(this,fe).call(this,e),e;let n=await s(this,ot).select(s(this,de));return await s(this,Te).call(this,async a=>{let[r,o]=await Promise.all([a.getCapabilities(),a.authorize({chain:n,identity:s(this,xe),sign_in_payload:t})]),i=s(this,dt).call(this,o.accounts),c={...o,accounts:i,chain:n,capabilities:r};return Promise.all([s(this,ct).call(this,r),s(this,X).set(c),s(this,fe).call(this,c)]),c})}catch(e){throw new Error(z(e),{cause:e})}});_(this,fe,async t=>{let e=s(this,B)==null||s(this,B)?.accounts.length!==t.accounts.length||s(this,B).accounts.some((n,a)=>n.address!==t.accounts[a].address);h(this,B,t),e&&D(this,Re,Jt).call(this,"change",{accounts:this.accounts})});_(this,ct,async t=>{let e=t.features.includes("solana:signTransactions"),n=t.supports_sign_and_send_transactions,a=te in this.features!==n||ne in this.features!==e;h(this,Ue,{...(n||!n&&!e)&&{[te]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signAndSendTransaction:s(this,_t)}},...e&&{[ne]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signTransaction:s(this,ut)}}}),a&&D(this,Re,Jt).call(this,"change",{features:this.features})});_(this,Pe,async(t,e,n)=>{try{let[a,r]=await Promise.all([s(this,B)?.capabilities??await t.getCapabilities(),t.authorize({auth_token:e,identity:s(this,xe),chain:n})]),o=s(this,dt).call(this,r.accounts),i={...r,accounts:o,chain:n,capabilities:a};Promise.all([s(this,X).set(i),s(this,fe).call(this,i)])}catch(a){throw s(this,lt).call(this),new Error(z(a),{cause:a})}});_(this,lt,async()=>{s(this,X).clear(),h(this,J,!1),Tn(this,Me)._++,h(this,B,void 0),D(this,Re,Jt).call(this,"change",{accounts:this.accounts})});_(this,Te,async t=>{let e=s(this,B)?.wallet_uri_base,n=e?{baseUri:e}:void 0,a=s(this,Me),r=new fR;try{let o=!0,i,c=await Promise.race([to().then(async()=>{r.init();let{wallet:l,close:u}=await Fa(n);o=!1,r.addEventListener("close",f=>{f&&u()}),r.open();let R=await t(await l);return r.close(),u(),R}),new Promise((l,u)=>{i=setTimeout(()=>{o&&u(new g(T.ERROR_ASSOCIATION_CANCELLED,"Wallet connection timed out",{event:void 0}))},bR)})]);return clearTimeout(i),c}catch(o){throw r.close(),s(this,Me)!==a&&await new Promise(()=>{}),o instanceof Error&&o.name==="SolanaMobileWalletAdapterError"&&o.code==="ERROR_WALLET_NOT_FOUND"&&await s(this,it).call(this,this),o}});_(this,Be,()=>{if(!s(this,B))throw new Error("Wallet not connected");return{authToken:s(this,B).auth_token,chain:s(this,B).chain}});_(this,dt,t=>t.map(e=>{let n=x(e.address);return{address:Ce(n),publicKey:n,label:e.label,icon:e.icon,chains:e.chains??s(this,de),features:e.features??so}}));_(this,ln,async t=>{let{authToken:e,chain:n}=s(this,Be).call(this);try{let a=t.map(r=>Y(r));return await s(this,Te).call(this,async r=>(await s(this,Pe).call(this,r,e,n),(await r.signTransactions({payloads:a})).signed_payloads.map(x)))}catch(a){throw new Error(z(a),{cause:a})}});_(this,dn,async(t,e)=>{let{authToken:n,chain:a}=s(this,Be).call(this);try{return await s(this,Te).call(this,async r=>{let[o]=await Promise.all([r.getCapabilities(),s(this,Pe).call(this,r,n,a)]);if(o.supports_sign_and_send_transactions){let i=Y(t);return(await r.signAndSendTransactions({...e,payloads:[i]})).signatures.map(x)[0]}else throw new Error("connected wallet does not support signAndSendTransaction")})}catch(r){throw new Error(z(r),{cause:r})}});_(this,_t,async(...t)=>{let e=[];for(let n of t){let a=await s(this,dn).call(this,n.transaction,n.options);e.push({signature:a})}return e});_(this,ut,async(...t)=>(await s(this,ln).call(this,t.map(({transaction:e})=>e))).map(e=>({signedTransaction:e})));_(this,_n,async(...t)=>{let{authToken:e,chain:n}=s(this,Be).call(this),a=t.map(({account:o})=>Y(new Uint8Array(o.publicKey))),r=t.map(({message:o})=>Y(o));try{return await s(this,Te).call(this,async o=>(await s(this,Pe).call(this,o,e,n),(await o.signMessages({addresses:a,payloads:r})).signed_payloads.map(x).map(i=>({signedMessage:i,signature:i.slice(-io)}))))}catch(o){throw new Error(z(o),{cause:o})}});_(this,un,async(...t)=>{let e=[];if(t.length>1)for(let n of t)e.push(await s(this,Rt).call(this,n));else return[await s(this,Rt).call(this,t[0])];return e});_(this,Rt,async t=>{h(this,J,!0);try{let e=await s(this,st).call(this,{...t,domain:t?.domain??window.location.host});if(!e.sign_in_result)throw new Error("Sign in failed, no sign in result returned by wallet");let n=e.sign_in_result.address,a=e.accounts.find(r=>r.address==n);return{account:{...a??{address:Ce(x(n))},publicKey:x(n),chains:a?.chains??s(this,de),features:a?.features??e.capabilities.features},signedMessage:x(e.sign_in_result.signed_message),signature:x(e.sign_in_result.signature)}}catch(e){throw new Error(z(e),{cause:e})}finally{h(this,J,!1)}});h(this,X,t.authorizationCache),h(this,xe,t.appIdentity),h(this,de,t.chains),h(this,ot,t.chainSelector),h(this,it,t.onWalletNotFound),h(this,Ue,{[te]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signAndSendTransaction:s(this,_t)},[ne]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signTransaction:s(this,ut)}})}get version(){return s(this,nn)}get name(){return s(this,an)}get url(){return s(this,rn)}get icon(){return s(this,on)}get chains(){return s(this,de)}get features(){return{[Mn]:{version:"1.0.0",connect:s(this,cn)},[Un]:{version:"1.0.0",disconnect:s(this,lt)},[Pn]:{version:"1.0.0",on:s(this,sn)},[$t]:{version:"1.0.0",signMessage:s(this,_n)},[Ft]:{version:"1.0.0",signIn:s(this,un)},...s(this,Ue)}}get accounts(){return s(this,B)?.accounts??[]}get connected(){return!!s(this,B)}get isAuthorized(){return!!s(this,B)}get currentAuthorization(){return s(this,B)}get cachedAuthorizationResult(){return s(this,X).get()}},le=new WeakMap,nn=new WeakMap,an=new WeakMap,rn=new WeakMap,on=new WeakMap,xe=new WeakMap,B=new WeakMap,X=new WeakMap,J=new WeakMap,Me=new WeakMap,de=new WeakMap,ot=new WeakMap,Ue=new WeakMap,it=new WeakMap,sn=new WeakMap,Re=new WeakSet,Jt=function(t,...e){s(this,le)[t]?.forEach(n=>n.apply(null,e))},co=function(t,e){s(this,le)[t]=s(this,le)[t]?.filter(n=>e!==n)},cn=new WeakMap,st=new WeakMap,fe=new WeakMap,ct=new WeakMap,Pe=new WeakMap,lt=new WeakMap,Te=new WeakMap,Be=new WeakMap,dt=new WeakMap,ln=new WeakMap,dn=new WeakMap,_t=new WeakMap,ut=new WeakMap,_n=new WeakMap,un=new WeakMap,Rt=new WeakMap,Kr),_e,Rn,En,hn,An,Fe,F,Z,Q,$e,ue,Et,ke,ht,At,W,On,Ee,Zt,lo,Nn,Ot,Ve,Sn,Ge,Nt,Ie,ze,St,mn,pn,mt,pt,gn,fn,gt,Wr,vR=(Wr=class{constructor(t){_(this,Ee);_(this,_e,{});_(this,Rn,"1.0.0");_(this,En,LR);_(this,hn,"https://solanamobile.com/wallets");_(this,An,oo);_(this,Fe);_(this,F);_(this,Z);_(this,Q,!1);_(this,$e,0);_(this,ue,[]);_(this,Et);_(this,ke);_(this,ht);_(this,At);_(this,W);_(this,On,(t,e)=>(s(this,_e)[t]?.push(e)||(s(this,_e)[t]=[e]),()=>D(this,Ee,lo).call(this,t,e)));_(this,Nn,async(t={})=>{if(s(this,Q)||this.connected)return{accounts:this.accounts};h(this,Q,!0);try{await s(this,Ot).call(this)}catch(e){throw new Error(z(e),{cause:e})}finally{h(this,Q,!1)}return{accounts:this.accounts}});_(this,Ot,async t=>{try{let e=await s(this,Z).get();if(e)return s(this,Ve).call(this,e),e;s(this,W)&&h(this,W,void 0);let n=await s(this,Et).select(s(this,ue));return await s(this,Ie).call(this,async a=>{let[r,o]=await Promise.all([a.getCapabilities(),a.authorize({chain:n,identity:s(this,Fe),sign_in_payload:t})]),i=s(this,St).call(this,o.accounts),c={...o,accounts:i,chain:n,capabilities:r};return Promise.all([s(this,Sn).call(this,r),s(this,Z).set(c),s(this,Ve).call(this,c)]),c})}catch(e){throw new Error(z(e),{cause:e})}});_(this,Ve,async t=>{let e=s(this,F)==null||s(this,F)?.accounts.length!==t.accounts.length||s(this,F).accounts.some((n,a)=>n.address!==t.accounts[a].address);h(this,F,t),e&&D(this,Ee,Zt).call(this,"change",{accounts:this.accounts})});_(this,Sn,async t=>{let e=t.features.includes("solana:signTransactions"),n=t.supports_sign_and_send_transactions||t.features.includes("solana:signAndSendTransaction"),a=te in this.features!==n||ne in this.features!==e;h(this,ke,{...n&&{[te]:{version:"1.0.0",supportedTransactionVersions:t.supported_transaction_versions,signAndSendTransaction:s(this,mt)}},...e&&{[ne]:{version:"1.0.0",supportedTransactionVersions:t.supported_transaction_versions,signTransaction:s(this,pt)}}}),a&&D(this,Ee,Zt).call(this,"change",{features:this.features})});_(this,Ge,async(t,e,n)=>{try{let[a,r]=await Promise.all([s(this,F)?.capabilities??await t.getCapabilities(),t.authorize({auth_token:e,identity:s(this,Fe),chain:n})]),o=s(this,St).call(this,r.accounts),i={...r,accounts:o,chain:n,capabilities:a};Promise.all([s(this,Z).set(i),s(this,Ve).call(this,i)])}catch(a){throw s(this,Nt).call(this),new Error(z(a),{cause:a})}});_(this,Nt,async()=>{s(this,W)?.close(),s(this,Z).clear(),h(this,Q,!1),Tn(this,$e)._++,h(this,F,void 0),h(this,W,void 0),D(this,Ee,Zt).call(this,"change",{accounts:this.accounts})});_(this,Ie,async t=>{let e=s(this,F)?.wallet_uri_base,n={...e?{baseUri:e}:void 0,remoteHostAuthority:s(this,At)},a=s(this,$e),r=new TR;if(s(this,W))return t(s(this,W).wallet);try{r.init(),r.open();let{associationUrl:o,close:i,wallet:c}=await $a(n),l=r.addEventListener("close",u=>{u&&i()});return r.populateQRCode(o.toString()),h(this,W,{close:i,wallet:await c}),l(),r.close(),await t(s(this,W).wallet)}catch(o){throw r.close(),s(this,$e)!==a&&await new Promise(()=>{}),o instanceof Error&&o.name==="SolanaMobileWalletAdapterError"&&o.code==="ERROR_WALLET_NOT_FOUND"&&await s(this,ht).call(this,this),o}});_(this,ze,()=>{if(!s(this,F))throw new Error("Wallet not connected");return{authToken:s(this,F).auth_token,chain:s(this,F).chain}});_(this,St,t=>t.map(e=>{let n=x(e.address);return{address:Ce(n),publicKey:n,label:e.label,icon:e.icon,chains:e.chains??s(this,ue),features:e.features??so}}));_(this,mn,async t=>{let{authToken:e,chain:n}=s(this,ze).call(this);try{return await s(this,Ie).call(this,async a=>(await s(this,Ge).call(this,a,e,n),(await a.signTransactions({payloads:t.map(Y)})).signed_payloads.map(x)))}catch(a){throw new Error(z(a),{cause:a})}});_(this,pn,async(t,e)=>{let{authToken:n,chain:a}=s(this,ze).call(this);try{return await s(this,Ie).call(this,async r=>{let[o]=await Promise.all([r.getCapabilities(),s(this,Ge).call(this,r,n,a)]);if(o.supports_sign_and_send_transactions)return(await r.signAndSendTransactions({...e,payloads:[Y(t)]})).signatures.map(x)[0];throw new Error("connected wallet does not support signAndSendTransaction")})}catch(r){throw new Error(z(r),{cause:r})}});_(this,mt,async(...t)=>{let e=[];for(let n of t){let a=await s(this,pn).call(this,n.transaction,n.options);e.push({signature:a})}return e});_(this,pt,async(...t)=>(await s(this,mn).call(this,t.map(({transaction:e})=>e))).map(e=>({signedTransaction:e})));_(this,gn,async(...t)=>{let{authToken:e,chain:n}=s(this,ze).call(this),a=t.map(({account:o})=>Y(new Uint8Array(o.publicKey))),r=t.map(({message:o})=>Y(o));try{return await s(this,Ie).call(this,async o=>(await s(this,Ge).call(this,o,e,n),(await o.signMessages({addresses:a,payloads:r})).signed_payloads.map(x).map(i=>({signedMessage:i,signature:i.slice(-io)}))))}catch(o){throw new Error(z(o),{cause:o})}});_(this,fn,async(...t)=>{let e=[];if(t.length>1)for(let n of t)e.push(await s(this,gt).call(this,n));else return[await s(this,gt).call(this,t[0])];return e});_(this,gt,async t=>{h(this,Q,!0);try{let e=await s(this,Ot).call(this,{...t,domain:t?.domain??window.location.host});if(!e.sign_in_result)throw new Error("Sign in failed, no sign in result returned by wallet");let n=e.sign_in_result.address,a=e.accounts.find(r=>r.address==n);return{account:{...a??{address:Ce(x(n))},publicKey:x(n),chains:a?.chains??s(this,ue),features:a?.features??e.capabilities.features},signedMessage:x(e.sign_in_result.signed_message),signature:x(e.sign_in_result.signature)}}catch(e){throw new Error(z(e),{cause:e})}finally{h(this,Q,!1)}});h(this,Z,t.authorizationCache),h(this,Fe,t.appIdentity),h(this,ue,t.chains),h(this,Et,t.chainSelector),h(this,At,t.remoteHostAuthority),h(this,ht,t.onWalletNotFound),h(this,ke,{[te]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signAndSendTransaction:s(this,mt)},[ne]:{version:"1.0.0",supportedTransactionVersions:["legacy",0],signTransaction:s(this,pt)}})}get version(){return s(this,Rn)}get name(){return s(this,En)}get url(){return s(this,hn)}get icon(){return s(this,An)}get chains(){return s(this,ue)}get features(){return{[Mn]:{version:"1.0.0",connect:s(this,Nn)},[Un]:{version:"1.0.0",disconnect:s(this,Nt)},[Pn]:{version:"1.0.0",on:s(this,On)},[$t]:{version:"1.0.0",signMessage:s(this,gn)},[Ft]:{version:"1.0.0",signIn:s(this,fn)},...s(this,ke)}}get accounts(){return s(this,F)?.accounts??[]}get connected(){return!!s(this,W)&&!!s(this,F)}get isAuthorized(){return!!s(this,F)}get currentAuthorization(){return s(this,F)}get cachedAuthorizationResult(){return s(this,Z).get()}},_e=new WeakMap,Rn=new WeakMap,En=new WeakMap,hn=new WeakMap,An=new WeakMap,Fe=new WeakMap,F=new WeakMap,Z=new WeakMap,Q=new WeakMap,$e=new WeakMap,ue=new WeakMap,Et=new WeakMap,ke=new WeakMap,ht=new WeakMap,At=new WeakMap,W=new WeakMap,On=new WeakMap,Ee=new WeakSet,Zt=function(t,...e){s(this,_e)[t]?.forEach(n=>n.apply(null,e))},lo=function(t,e){s(this,_e)[t]=s(this,_e)[t]?.filter(n=>e!==n)},Nn=new WeakMap,Ot=new WeakMap,Ve=new WeakMap,Sn=new WeakMap,Ge=new WeakMap,Nt=new WeakMap,Ie=new WeakMap,ze=new WeakMap,St=new WeakMap,mn=new WeakMap,pn=new WeakMap,mt=new WeakMap,pt=new WeakMap,gn=new WeakMap,fn=new WeakMap,gt=new WeakMap,Wr);function DR(t){if(typeof window>"u"){console.warn("MWA not registered: no window object");return}if(!window.isSecureContext){console.warn("MWA not registered: secure context required (https)");return}let e=navigator.userAgent;OR()&&(!SR(e)||eo(e))?Dn(new yR(t)):NR()&&t.remoteHostAuthority!==void 0&&Dn(new vR({...t,remoteHostAuthority:t.remoteHostAuthority}))}export{Ju as createDefaultAuthorizationCache,Zu as createDefaultChainSelector,sR as defaultErrorModalWalletNotFoundHandler,DR as registerMwa};
