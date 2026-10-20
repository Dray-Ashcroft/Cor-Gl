"use strict";
var PRISTINE_HTML='';
try{PRISTINE_HTML='<!DOCTYPE html>\n'+document.documentElement.outerHTML;}catch(e){/* export feature will be unavailable in this environment; rest of the app is unaffected */}
/* ===== body: real 3D models (male: basic_humen_body.glb, female: female_body_base.glb) =====
   Both GLBs were converted offline: world transforms applied, scaled so the crown sits at y=182 with feet at y=0
   (same frame the glands use), torso centred on x=0/z=0, decimated to ~8k triangles for the canvas renderer,
   and quantised to 0.01-unit Int16. Data lives in BODY_MESH (separate <script> above).
   Face colour index: 0 skin, 1 sclera, 2 iris, 3 pupil. */
var BODY_PAL=[[224,181,152],[236,232,224],[92,64,44],[24,18,16]];
var BODY_CACHE={}, BODY_CI=null, BODY_VERTS=null, BODY_IX=null, BODY_SPAN=150, ORGANS_READY=false;
function b64ToBuf(s){var bin=atob(s),n=bin.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=bin.charCodeAt(i);return u.buffer;}
function buildBody(sex){
  var d=BODY_MESH[sex];
  var v=new Int16Array(b64ToBuf(d.v)), ix=new Uint16Array(b64ToBuf(d.i)), ci=new Uint8Array(b64ToBuf(d.c));
  var P=new Array(d.nv), span=0;
  for(var k=0;k<d.nv;k++){P[k]=[v[3*k]/100,v[3*k+1]/100,v[3*k+2]/100];var ax=Math.abs(P[k][0]);if(ax>span)span=ax;}
  var faces=new Array(d.nf),tri=new Array(d.nf);
  for(var t=0;t<d.nf;t++){tri[t]=[ix[3*t],ix[3*t+1],ix[3*t+2]];faces[t]=[P[tri[t][0]],P[tri[t][1]],P[tri[t][2]]];}
  return {faces:faces,verts:P,tri:tri,ci:ci,span:2*span};
}
let BODY=null, BODY_FN=null, XRAY=false;
function rebuildBody(sex){
  var b=BODY_CACHE[sex];
  if(!b){b=buildBody(sex);b.fn=smoothNormals(b.faces);BODY_CACHE[sex]=b;}
  BODY=b.faces;BODY_FN=b.fn;BODY_CI=b.ci;BODY_SPAN=b.span;BODY_VERTS=b.verts;BODY_IX=b.tri;
  if(ORGANS_READY)applyOrganLayout(sex);
}
/* Gland placement for each model (pos = gland origin in body frame, s = uniform size factor).
   Derived from landmarks measured on each mesh: eye centres, nasion, chin, sternal notch, crotch,
   and the transpyloric plane (L1, halfway between sternal notch and pubic symphysis).
     pituitary – sella turcica: ~eye level, ~7 cm behind nasion      pineal – ~3 above, ~4 behind pituitary
     thyroid   – front of lower neck, isthmus ~2 above sternal notch  parathyroids – posterior surface of lobes
     pancreas  – neck on L1 (head lower on body's right, tail rising to left)
     adrenals  – T12, above pancreas body, posterior third of trunk depth
     ovaries/uterus – true pelvis just above pubic symphysis        testes – below pubis, between upper thighs
   Every gland vertex was checked to lie inside its body mesh (testes 89% – the remainder sits in the thigh gap,
   as this model has no modelled scrotum). */
var ORGAN_LAYOUT={"male":{"pituitary":{"pos":[0.0,170.44,4.73],"s":1.0},"pineal":{"pos":[0.0,173.44,0.93],"s":1.0},"thyroid":{"pos":[0.0,153.71,1.9],"s":0.7},"parathyroid":{"pos":[0.0,154.06,-0.13],"s":0.7},"pancreas":{"pos":[-1.0,121.42,0.73],"s":1.0},"adrenal":{"pos":[0.0,125.22,-3.06],"s":0.8},"testes":{"pos":[0.0,89.25,2.0],"s":0.75}},"female":{"pituitary":{"pos":[0.0,170.3,1.97],"s":0.9},"pineal":{"pos":[0.0,173.3,-1.83],"s":0.9},"thyroid":{"pos":[0.0,154.58,-1.97],"s":0.6},"parathyroid":{"pos":[0.0,154.88,-3.71],"s":0.6},"pancreas":{"pos":[-0.75,122.47,1.53],"s":0.75},"adrenal":{"pos":[0.0,126.2,-1.74],"s":0.6},"ovaries":{"pos":[0.0,98.0,0.93],"s":0.85},"uterus":{"pos":[0.0,100.0,1.51],"s":0.85}}};
function applyOrganLayout(sx){
  var L=ORGAN_LAYOUT[sx]||{};
  for(var oi=0;oi<ORGANS.length;oi++){
    var o=ORGANS[oi],l=L[o.id],s=l?l.s:1;
    o.pos=l?l.pos.slice():o._basePos.slice();
    o._faces=o._baseFaces.map(function(f){return f.map(function(p){return[p[0]*s,p[1]*s,p[2]*s];});});
    o.hit=o._baseHit.map(function(h){return{o:[h.o[0]*s,h.o[1]*s,h.o[2]*s],r:h.r*s};});
    o._center=[o._baseCenter[0]*s,o._baseCenter[1]*s,o._baseCenter[2]*s];
  }
}
rebuildBody('male');
/* ===== smooth GPU skin (normal view) =====
   The skin is drawn with WebGL from the full-resolution GLB meshes (BODY_MESH_HI) using per-pixel
   shading with smoothed vertex normals, so there is no faceting. Same light, colours, rotation and
   perspective as the canvas renderer. X-ray mode and browsers without WebGL fall back to the canvas painter. */
var GLB=null,GL_EMA=0,GL_N=0;
function glInit(){
  if(GLB!==null)return GLB||null;
  GLB=false;
  try{
    var cv=document.createElement('canvas');
    var gl=cv.getContext('webgl',{antialias:true,alpha:true,premultipliedAlpha:true,preserveDrawingBuffer:false});
    if(!gl)return null;
    var VS='precision highp float;attribute vec3 aP;attribute vec3 aN;attribute float aC;uniform vec2 uRot;uniform vec4 uProj;varying vec3 vN;varying float vC;'+
      'vec3 rot(vec3 p){float cy=cos(uRot.y),sy=sin(uRot.y),cx=cos(uRot.x),sx=sin(uRot.x);float x1=p.x*cy+p.z*sy,z1=-p.x*sy+p.z*cy;return vec3(x1,p.y*cx-z1*sx,p.y*sx+z1*cx);}'+
      'void main(){vec3 c=rot(aP);vN=rot(aN);vC=aC;float w=(uProj.w-c.z)/uProj.w;gl_Position=vec4(c.x*uProj.x,(c.y-uProj.z)*uProj.y,(-c.z/400.0)*w,w);}';
    var FS='precision mediump float;varying vec3 vN;varying float vC;uniform vec3 uL;uniform vec3 uH;'+
      'void main(){vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;'+
      'vec3 col=vC<0.5?vec3(224.,181.,152.):(vC<1.5?vec3(236.,232.,224.):(vC<2.5?vec3(92.,64.,44.):vec3(24.,18.,16.)));col/=255.;'+
      'float wrap=max(0.,dot(n,uL)*0.65+0.35);float spec=pow(max(0.,dot(n,uH)),26.)*0.55;float fres=pow(1.-min(1.,abs(n.z)),3.)*0.34;'+
      'vec3 c=col*(0.34+0.66*wrap);vec3 rim=min(vec3(1.),vec3(col.r*1.25,col.g*1.05,col.b*1.05)+vec3(40.,30.,30.)/255.);'+
      'c=mix(c,rim,fres);c=mix(c,vec3(1.,250./255.,244./255.),spec);gl_FragColor=vec4(c,1.);}';
    function sh(t,src){var s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    GLB={cv:cv,gl:gl,pr:pr,meshes:{},skipT:true,
      aP:gl.getAttribLocation(pr,'aP'),aN:gl.getAttribLocation(pr,'aN'),aC:gl.getAttribLocation(pr,'aC'),
      uRot:gl.getUniformLocation(pr,'uRot'),uProj:gl.getUniformLocation(pr,'uProj'),uL:gl.getUniformLocation(pr,'uL'),uH:gl.getUniformLocation(pr,'uH')};
    cv.addEventListener('webglcontextlost',function(e){e.preventDefault();GLB=false;});
    return GLB;
  }catch(e){GLB=false;return null;}
}
function glMesh(g,sx){
  if(g.meshes[sx])return g.meshes[sx];
  var d=BODY_MESH_HI[sx],gl=g.gl;
  var q=new Int16Array(b64ToBuf(d.v)),ix=new Uint16Array(b64ToBuf(d.i)),fc=new Uint8Array(b64ToBuf(d.c));
  var P=new Float32Array(q.length),N=new Float32Array(q.length),C=new Float32Array(d.nv);
  for(var k=0;k<q.length;k++)P[k]=q[k]/100;
  for(var t=0;t<d.nf;t++){ // area-weighted vertex normals
    var a=3*ix[3*t],b=3*ix[3*t+1],c=3*ix[3*t+2];
    var ux=P[b]-P[a],uy=P[b+1]-P[a+1],uz=P[b+2]-P[a+2],vx=P[c]-P[a],vy=P[c+1]-P[a+1],vz=P[c+2]-P[a+2];
    var nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    N[a]+=nx;N[a+1]+=ny;N[a+2]+=nz;N[b]+=nx;N[b+1]+=ny;N[b+2]+=nz;N[c]+=nx;N[c+1]+=ny;N[c+2]+=nz;
    if(fc[t]){C[a/3]=fc[t];C[b/3]=fc[t];C[c/3]=fc[t];}
  }
  for(var v=0;v<d.nv;v++){var l=Math.hypot(N[3*v],N[3*v+1],N[3*v+2])||1;N[3*v]/=l;N[3*v+1]/=l;N[3*v+2]/=l;}
  function buf(arr,type){var bb=gl.createBuffer();gl.bindBuffer(type,bb);gl.bufferData(type,arr,gl.STATIC_DRAW);return bb;}
  var m={p:buf(P,gl.ARRAY_BUFFER),n:buf(N,gl.ARRAY_BUFFER),c:buf(C,gl.ARRAY_BUFFER),i:buf(ix,gl.ELEMENT_ARRAY_BUFFER),count:ix.length};
  g.meshes[sx]=m;g.skipT=true;return m;
}
/* renders the skin into the offscreen GL canvas; returns that canvas, or null to use the canvas painter */
function glRenderBody(sc,dist){
  var g=glInit();if(!g)return null;
  try{
    var gl=g.gl,cv=g.cv,pw=Math.round(W*DPR),ph=Math.round(H*DPR);
    if(cv.width!==pw||cv.height!==ph){cv.width=pw;cv.height=ph;}
    var m=glMesh(g,sex);
    gl.viewport(0,0,pw,ph);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.useProgram(g.pr);
    gl.uniform2f(g.uRot,angX,angY);gl.uniform4f(g.uProj,sc/(W/2),sc/(H/2),CY,dist);
    gl.uniform3f(g.uL,LIGHT[0],LIGHT[1],LIGHT[2]);gl.uniform3f(g.uH,HALF[0],HALF[1],HALF[2]);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.p);gl.enableVertexAttribArray(g.aP);gl.vertexAttribPointer(g.aP,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.n);gl.enableVertexAttribArray(g.aN);gl.vertexAttribPointer(g.aN,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.c);gl.enableVertexAttribArray(g.aC);gl.vertexAttribPointer(g.aC,1,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.i);gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_SHORT,0);
    return cv;
  }catch(e){GLB=false;return null;}
}

/* ===== organ mesh generator ===== */
function faceNormal(f){const a=f[0],b=f[1],c=f[2];const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],w=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];return[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];}
function faceCtr(f){let x=0,y=0,z=0;for(const p of f){x+=p[0];y+=p[1];z+=p[2];}const n=f.length;return[x/n,y/n,z/n];}
function eul(p,e){let x=p[0],y=p[1],z=p[2];let c=Math.cos(e[0]),s=Math.sin(e[0]);let y1=y*c-z*s,z1=y*s+z*c;y=y1;z=z1;c=Math.cos(e[1]);s=Math.sin(e[1]);let x1=x*c+z*s,z2=-x*s+z*c;x=x1;z=z2;c=Math.cos(e[2]);s=Math.sin(e[2]);let x2=x*c-y*s,y2=x*s+y*c;return[x2,y2,z];}
function organMesh(part){
  const LON=part.lon||20,LAT=part.lat||13;
  const r=part.r,amp=part.amp||0,seed=part.seed||1;
  const tT=part.taperTop||0,tB=part.taperBot||0,bend=part.bend||0,flat=part.flattenZ==null?1:part.flattenZ;
  const orient=part.orient||[0,0,0],o=part.o||[0,0,0];
  const grid=[];
  for(let i=0;i<=LAT;i++){
    const v=i/LAT*Math.PI,sv=Math.sin(v),cv=Math.cos(v);const row=[];
    for(let j=0;j<LON;j++){
      const u=j/LON*6.28318;let dx=sv*Math.cos(u),dy=cv,dz=sv*Math.sin(u);
      let disp=1;if(amp)disp+=amp*sv*(Math.sin(u*1.7+seed)+0.6*Math.sin(u*2.9+v*2.3+seed*1.7)+0.5*Math.sin(v*3.1+seed))*0.33;
      let x=dx*disp*r[0],y=dy*disp*r[1],z=dz*disp*r[2]*flat;
      const tf=Math.max(0,y/r[1]),bf=Math.max(0,-y/r[1]);let sc=1-tT*tf*tf-tB*bf*bf;if(sc<0.04)sc=0.04;x*=sc;z*=sc;
      x+=bend*(y/r[1])*(y/r[1])*r[0];
      row.push(eul([x,y,z],orient));
    }
    grid.push(row);
  }
  const faces=[],refc=eul([0,0,0],orient),rr=[refc[0]+o[0],refc[1]+o[1],refc[2]+o[2]];
  for(let i=0;i<LAT;i++)for(let j=0;j<LON;j++){
    let f=[grid[i][j],grid[i][(j+1)%LON],grid[i+1][(j+1)%LON],grid[i+1][j]].map(p=>[p[0]+o[0],p[1]+o[1],p[2]+o[2]]);
    const n=faceNormal(f),ct=faceCtr(f);
    faces.push((n[0]*(ct[0]-rr[0])+n[1]*(ct[1]-rr[1])+n[2]*(ct[2]-rr[2]))<0?[f[0],f[3],f[2],f[1]]:f);
  }
  return faces;
}
const PANC=[[-10.2,-1.0,-0.1,1.3,1.3],[-9.2,-0.8,0.1,2.4,2.1],[-7.6,0,0.7,3.1,2.6],[-5.9,0.4,0.9,2.8,2.4],[-4.3,0.7,1.3,2.0,1.9],[-2.0,1.0,1.5,2.3,2.0],[1.0,1.5,1.4,2.2,1.85],[4.0,2.0,1.1,1.9,1.65],[6.6,2.5,0.7,1.5,1.3],[8.9,3.0,0.3,1.05,1.0],[10.4,3.3,0,0.5,0.5]];
function phash(n){const x=Math.sin(n*127.1+13.7)*43758.5453;return x-Math.floor(x);}
const PLSEED=(function(){const a=[];for(let r=0;r<12;r++)for(let c=0;c<8;c++)a.push([((c+0.5)/8+(r%2?0.0625:0)+(phash(r*3+c*11)-0.5)*0.05+1)%1,(r+0.5)/12+(phash(r*7+c)-0.5)*0.05]);return a;})();
function plob(u01,s){let best=1e9;for(const sd of PLSEED){let du=Math.abs(u01-sd[0]);if(du>0.5)du=1-du;du*=1.3;const d=Math.hypot(du,s-sd[1]);if(d<best)best=d;}const R=0.085;return best>=R?0:0.5*(1+Math.cos(best/R*Math.PI));}
function loftPancreas(){
  const SEG=24,NR=32,faces=[];
  const ring=t=>{const x=t*(PANC.length-1);let i=Math.floor(x);if(i>=PANC.length-1)i=PANC.length-2;const f=x-i,a=PANC[i],b=PANC[i+1];return a.map((v,k)=>v+(b[k]-v)*f);};
  const grids=[];
  for(let ri=0;ri<=NR;ri++){const t=ri/NR,r=ring(t),row=[];for(let j=0;j<SEG;j++){const a=j/SEG*6.28318;const disp=1+plob(j/SEG,t)*0.14;row.push([r[0],r[1]+r[3]*Math.cos(a)*disp,r[2]+r[4]*Math.sin(a)*disp]);}grids.push(row);}
  const cull=(f,ref)=>{const n=faceNormal(f),c=faceCtr(f);return (n[0]*(c[0]-ref[0])+n[1]*(c[1]-ref[1])+n[2]*(c[2]-ref[2]))<0?[f[0],f[3],f[2],f[1]]:f;};
  for(let i=0;i<NR;i++){const rc=ring((i+0.5)/NR),ref=[rc[0],rc[1],rc[2]];for(let j=0;j<SEG;j++)faces.push(cull([grids[i][j],grids[i][(j+1)%SEG],grids[i+1][(j+1)%SEG],grids[i+1][j]],ref));}
  const r0=ring(0),rN=ring(1);
  for(let j=0;j<SEG;j++)faces.push(cull([[r0[0],r0[1],r0[2]],grids[0][(j+1)%SEG],grids[0][j]],ring(0.05)));
  for(let j=0;j<SEG;j++)faces.push(cull([[rN[0],rN[1],rN[2]],grids[NR][j],grids[NR][(j+1)%SEG]],ring(0.95)));
  return faces;
}

/* ===== organs ===== */
const ORGANS=[
 {id:'pituitary',name:'Pituitary Gland',grp:'all',color:'#c98f98',pos:[0,160.5,0.4],
  parts:[{r:[2.4,1.7,2.0],taperBot:.15,amp:.05,seed:2},{r:[0.55,2.4,0.55],o:[0,2.3,-0.2],lon:10,lat:8}],
  hit:[{o:[0,0,0],r:2.3}],
  hormone:'Growth Hormone (GH)',func:'Controls the <b>growth</b> of the body — bones and muscles. It is called the <b>master gland</b> because it also controls the other endocrine glands.',note:'Too little in childhood → dwarfism; too much → gigantism.',
  core:['Growth Hormone (GH)','Vasopressin (ADH)'],extra:['FSH','LH','TSH','ACTH','Prolactin','Oxytocin (demo under Uterus)'],
  targets:[
    {id:'thyroid',hormone:'TSH (Thyroid Stimulating Hormone)'},
    {id:'adrenal',hormone:'ACTH (Adrenocorticotropic Hormone)'},
    {id:'ovaries',hormone:'Gonadotropins (FSH/LH)',sexReq:'female'},
    {id:'testes',hormone:'Gonadotropins (FSH/LH)',sexReq:'male'},
    {id:'uterus',hormone:'Oxytocin',sexReq:'female'}
  ]},
 {id:'pineal',name:'Pineal Gland',grp:'all',color:'#a86a5c',pos:[0,165,-4],
  parts:[{r:[1.5,2.0,1.5],taperTop:.55,amp:.08,seed:5,lon:16,lat:11}],
  hormone:'Melatonin',func:'Controls the <b>sleep–wake cycle</b> — the body’s daily clock.',note:'More melatonin is made in the dark, which makes you feel sleepy.',
  core:['Melatonin'],extra:[]},
 {id:'thyroid',name:'Thyroid Gland',grp:'all',color:'#a83a30',pos:[0,151.5,6.3],
  parts:[{r:[2.4,4.6,2.5],taperTop:.5,bend:.28,amp:.05,seed:3,o:[3.6,0,0],orient:[0,0,-0.14]},{r:[2.4,4.6,2.5],taperTop:.5,bend:-.28,amp:.05,seed:7,o:[-3.6,0,0],orient:[0,0,0.14]},{r:[2.6,1.3,1.5],flattenZ:.7,o:[0,-1.3,0.5],lon:16,lat:9}],
  hit:[{o:[3.6,0,0],r:3.2},{o:[-3.6,0,0],r:3.2},{o:[0,-1.3,0.5],r:2.4}],
  hormone:'Thyroxine',func:'Controls the <b>rate of metabolism</b> — how fast the body uses carbohydrates, fats and proteins. Needed for normal growth.',note:'Needs <b>iodine</b>. Lack of iodine → goitre (swelling of the neck).',
  core:['Thyroxine (T4)'],extra:['Triiodothyronine (T3)','Calcitonin']},
 {id:'parathyroid',name:'Parathyroid Glands',grp:'all',color:'#cba24e',pos:[0,152,3.4],
  parts:[{r:[0.95,1.25,0.6],amp:.04,seed:2,o:[3.8,2.0,-1.0],lon:12,lat:8},{r:[0.95,1.25,0.6],amp:.04,seed:4,o:[3.5,-2.0,-1.0],lon:12,lat:8},{r:[0.95,1.25,0.6],amp:.04,seed:6,o:[-3.8,2.0,-1.0],lon:12,lat:8},{r:[0.95,1.25,0.6],amp:.04,seed:8,o:[-3.5,-2.0,-1.0],lon:12,lat:8}],
  hormone:'Parathormone',func:'Controls the amount of <b>calcium and phosphate</b> in the blood and bones.',note:'Keeps bones and teeth strong and healthy.',
  core:['Parathormone (PTH)'],extra:[]},
 {id:'adrenal',name:'Adrenal Glands',grp:'all',color:'#e6c24f',pos:[0,110,-3.5],
  parts:[{r:[3.4,3.1,2.5],taperTop:.85,flattenZ:.8,amp:.06,seed:2,o:[9,0.5,0],orient:[0,0,-0.25]},{r:[3.6,3.2,2.4],taperTop:.35,bend:.5,flattenZ:.8,amp:.06,seed:6,o:[-9,0.5,0],orient:[0,0,0.25]}],
  hormone:'Adrenaline',func:'Prepares the body for an <b>emergency</b> — the “fight-or-flight” response. It raises the heartbeat, breathing rate and blood pressure.',note:'Released when you are scared, angry or excited. Sits on top of the kidneys.',
  core:['Adrenaline (Epinephrine)'],extra:['Noradrenaline (Norepinephrine)','Cortisol','Aldosterone']},
 {id:'pancreas',name:'Pancreas',grp:'all',color:'#d6a374',pos:[-1,115,-1],pancreas:true,
  hit:[{o:[-7,0,0],r:3.0},{o:[0,1,0],r:2.6},{o:[7,2,0],r:2.2}],
  hormone:'Insulin &amp; Glucagon',func:'<b>Insulin</b> lowers blood sugar when it rises too high; <b>Glucagon</b> raises it when it falls too low. Together they keep blood glucose steady.',note:'Too little insulin → <b>diabetes</b> (blood sugar stays high).',demo:'sugar',
  core:['Insulin','Glucagon'],extra:[]},
 {id:'ovaries',name:'Ovary',grp:'female',color:'#d9bcb4',pos:[0,97,1.5],
  parts:[{r:[2.1,3.0,1.95],taperTop:.42,taperBot:.42,amp:.05,seed:4,o:[7,0,0]},{r:[2.1,3.0,1.95],taperTop:.42,taperBot:.42,amp:.05,seed:9,o:[-7,0,0]}],
  hormone:'Estrogen &amp; Progesterone',func:'<b>Estrogen</b> controls female secondary sexual characters at puberty and regulates the menstrual cycle. <b>Progesterone</b> prepares the uterus wall to receive a fertilised egg.',note:'The female reproductive gland.',
  core:['Estrogen','Progesterone'],extra:['Relaxin']},
 {id:'testes',name:'Testis',grp:'male',color:'#e0cbb3',pos:[0,84,3.5],
  parts:[{r:[3.0,3.8,3.0],taperTop:.12,taperBot:.12,amp:.03,seed:5,o:[4,-2,0]},{r:[3.0,3.8,3.0],taperTop:.12,taperBot:.12,amp:.03,seed:11,o:[-4,-2,0]}],
  hormone:'Testosterone',func:'Controls <b>male secondary sexual characters</b> at puberty — deep voice, facial hair and body growth — and is needed for the <b>formation of sperm</b>.',note:'The male reproductive gland.',
  core:['Testosterone'],extra:[]},
 {id:'uterus',name:'Uterus',grp:'female',color:'#c1706a',pos:[0,99,2],origin:'Posterior Pituitary',
  parts:[{r:[3.2,4.0,2.8],taperBot:.55,amp:.05,seed:3},{r:[1.1,2.0,1.1],taperBot:.2,o:[0,-4.2,0],lon:12,lat:9},{r:[1.2,1.0,1.0],o:[3.0,3.0,0],lon:10,lat:8,orient:[0,0,-0.6]},{r:[1.2,1.0,1.0],o:[-3.0,3.0,0],lon:10,lat:8,orient:[0,0,0.6]}],
  hit:[{o:[0,0,0],r:4.0}],
  hormone:'Oxytocin',func:'The uterus is the <b>target organ</b> of oxytocin. Oxytocin makes the thick uterus muscle <b>contract in waves</b> during childbirth, and also causes <b>milk ejection</b> during breastfeeding.',note:'Oxytocin is released by the posterior pituitary. As contractions stretch the uterus, even more oxytocin is released \u2014 a rare example of <b>positive feedback</b>.'}
];
/* precompute organ meshes (relative to organ pos) + hit spheres + centroid */
for(const o of ORGANS){
  const faces=[];
  if(o.pancreas){for(const f of loftPancreas())faces.push(f);}else for(const p of o.parts){ for(const f of organMesh(p)) faces.push(f); }
  o._faces=faces;
  let cx=0,cy=0,cz=0,n=0;
  for(const f of faces)for(const v of f){cx+=v[0];cy+=v[1];cz+=v[2];n++;}
  o._center=[cx/n,cy/n,cz/n];
  o._fn=smoothNormals(faces);
  if(!o.hit){o.hit=(o.parts||[]).map(p=>({o:p.o||[0,0,0],r:Math.max(p.r[0],p.r[1],p.r[2])*0.9}));}
  o._basePos=o.pos.slice();o._baseFaces=o._faces;o._baseHit=o.hit;o._baseCenter=o._center;
}
ORGANS_READY=true;applyOrganLayout('male');

/* ===== math + colour ===== */
function rotate(p,ax,ay){const cy=Math.cos(ay),sy=Math.sin(ay);const x1=p[0]*cy+p[2]*sy,z1=-p[0]*sy+p[2]*cy;const cx=Math.cos(ax),sx=Math.sin(ax);return[x1,p[1]*cx-z1*sx,p[1]*sx+z1*cx];}
const LIGHT=(function(){const l=[-0.42,0.5,0.92];const m=Math.hypot(l[0],l[1],l[2]);return[l[0]/m,l[1]/m,l[2]/m];})();
function hx(c){return[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];}
function mix(a,b,t){return[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];}
function css(a){return'rgb('+(a[0]|0)+','+(a[1]|0)+','+(a[2]|0)+')';}
const COL={};for(const o of ORGANS)COL[o.id]=hx(o.color);

/* ===== state ===== */
const view=document.getElementById('view'),ctx=view.getContext('2d');
let W=0,H=0,DPR=1,CY=95;
let angX=0.05,angY=0.0,zoom=1;
let autoSpin=true,sex='male',selected=null,hoverId=null;
let drag=false,lastX=0,lastY=0,vel=0,moved=0;

function resize(){if(!homeActive)return;const r=view.getBoundingClientRect();const w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));DPR=Math.min(2,window.devicePixelRatio||1);if(w===W&&h===H)return;W=w;H=h;view.width=w*DPR;view.height=h*DPR;ctx.setTransform(DPR,0,0,DPR,0,0);draw();}
let rt;window.addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(resize,120);});
function baseScale(){return Math.min(W/Math.max(150,BODY_SPAN+14),H/200)*0.92*zoom;}
function visible(o){return!((o.grp==='male'&&sex!=='male')||(o.grp==='female'&&sex!=='female'));}

/* organ face shading */
function keyOf(v){return Math.round(v[0]*50)+"_"+Math.round(v[1]*50)+"_"+Math.round(v[2]*50);}
function smoothNormals(faces){
  var acc={};
  for(var i=0;i<faces.length;i++){var n=faceNormal(faces[i]);for(var k=0;k<faces[i].length;k++){var key=keyOf(faces[i][k]);if(!acc[key])acc[key]=[0,0,0];acc[key][0]+=n[0];acc[key][1]+=n[1];acc[key][2]+=n[2];}}
  var fn=new Array(faces.length);
  for(var i=0;i<faces.length;i++){var sx=0,sy=0,sz=0;for(var k=0;k<faces[i].length;k++){var a=acc[keyOf(faces[i][k])];sx+=a[0];sy+=a[1];sz+=a[2];}var l=Math.hypot(sx,sy,sz)||1;fn[i]=[sx/l,sy/l,sz/l];}
  return fn;
}
function h1(n){var x=Math.sin(n*12.9898)*43758.5453;return x-Math.floor(x);}
var VIEW=[0,0,1];
var HALF=(function(){var v=[LIGHT[0]+VIEW[0],LIGHT[1]+VIEW[1],LIGHT[2]+VIEW[2]];var m=Math.hypot(v[0],v[1],v[2]);return[v[0]/m,v[1]/m,v[2]/m];})();
function shadeFace(col,n,nz,seed){
  var nl=Math.hypot(n[0],n[1],n[2])||1;
  var ndl=(n[0]*LIGHT[0]+n[1]*LIGHT[1]+n[2]*LIGHT[2])/nl;
  var wrap=Math.max(0,ndl*0.65+0.35);
  var ndh=Math.max(0,(n[0]*HALF[0]+n[1]*HALF[1]+n[2]*HALF[2])/nl);
  var spec=Math.pow(ndh,26)*0.55;
  var fres=Math.pow(1-Math.min(1,Math.abs(nz)),3)*0.34;
  var l=0.34+0.66*wrap;
  var c=[col[0]*l,col[1]*l,col[2]*l];
  var rim=[Math.min(255,col[0]*1.25+40),Math.min(255,col[1]*1.05+30),Math.min(255,col[2]*1.05+30)];
  c=mix(c,rim,fres);
  c=mix(c,[255,250,244],spec);
  if(seed!=null){var m=(h1(seed)-0.5)*0.10;c=[c[0]*(1+m),c[1]*(1+m),c[2]*(1+m*0.6)];}
  return c;
}

function draw(){
  if(!W)return;
  const bg=ctx.createRadialGradient(W/2,H*0.42,10,W/2,H*0.5,Math.max(W,H)*0.7);
  bg.addColorStop(0,'#152033');bg.addColorStop(1,'#0b1119');
  ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
  const sc=baseScale(),dist=420;
  const proj=p=>{const f=dist/(dist-p[2]);return[W/2+p[0]*sc*f,H/2-(p[1]-CY)*sc*f,p[2],f];};
  const draws=[];
  // body
  const SKIN=[224,181,152];
  // shared vertices are rotated + projected once per frame, then looked up by each triangle
  const _gt0=performance.now(),glSkin=XRAY?null:glRenderBody(sc,dist);
  const RV=new Array(glSkin?0:BODY_VERTS.length);
  for(let k=0;k<RV.length;k++)RV[k]=proj(rotate(BODY_VERTS[k],angX,angY));
  for(let i=0;i<(glSkin?0:BODY.length);i++){
    const n=rotate(BODY_FN[i],angX,angY);const nz=n[2];
    if(nz<=0.015)continue;
    const t=BODY_IX[i],pts=[RV[t[0]],RV[t[1]],RV[t[2]]];const d=(pts[0][2]+pts[1][2]+pts[2][2])/3;
    if(XRAY){
      draws.push({d:d-0.3,t:'fx',pts});
    } else {
      const ci=BODY_CI[i];const c=shadeFace(ci?BODY_PAL[ci]:SKIN,n,nz,null);
      draws.push({d,t:'f',pts,col:c});
    }
  }
  // organs
  const organScreen={};
  for(const o of ORGANS){
    if(!visible(o))continue;
    for(let i=0;i<o._faces.length;i++){
      const f=o._faces[i];
      const cam=f.map(v=>rotate([v[0]+o.pos[0],v[1]+o.pos[1],v[2]+o.pos[2]],angX,angY));
      const n=rotate(o._fn[i],angX,angY);const nz=n[2];
      if(nz<=0.02)continue;
      const pts=cam.map(proj);let d=0;for(const p of pts)d+=p[2];d/=pts.length;
      if(XRAY)draws.push({d:d+0.15,t:'of',pts,col:shadeFace(COL[o.id],n,nz,i),hi:(selected===o.id||hoverId===o.id)});
    }
    // glow + hit
    const hs=[];
    for(const h of o.hit){const pr=proj(rotate([h.o[0]+o.pos[0],h.o[1]+o.pos[1],h.o[2]+o.pos[2]],angX,angY));hs.push({x:pr[0],y:pr[1],rx:h.r*sc*pr[3]*1.2,ry:h.r*sc*pr[3]*1.2,d:pr[2]});}
    organScreen[o.id]=hs;
    if(selected===o.id||hoverId===o.id){const cc=proj(rotate([o._center[0]+o.pos[0],o._center[1]+o.pos[1],o._center[2]+o.pos[2]],angX,angY));draws.push({d:cc[2]-6,t:'glow',x:cc[0],y:cc[1],r:26*sc*0.12+18});}
  }
  draws.sort((p,q)=>p.d-q.d);
  for(const dr of draws){
    if(dr.t==='fx'){ctx.beginPath();ctx.moveTo(dr.pts[0][0],dr.pts[0][1]);for(let i=1;i<dr.pts.length;i++)ctx.lineTo(dr.pts[i][0],dr.pts[i][1]);ctx.closePath();ctx.fillStyle='rgba(190,175,160,0.16)';ctx.fill();}
    else if(dr.t==='f'){const q=dr.pts,cs=css(dr.col);ctx.beginPath();ctx.moveTo(q[0][0],q[0][1]);ctx.lineTo(q[1][0],q[1][1]);ctx.lineTo(q[2][0],q[2][1]);ctx.closePath();ctx.fillStyle=cs;ctx.fill();ctx.strokeStyle=cs;ctx.lineWidth=0.9;ctx.stroke();}
    else if(dr.t==='glow'){const g=ctx.createRadialGradient(dr.x,dr.y,1,dr.x,dr.y,dr.r);g.addColorStop(0,'rgba(255,214,120,0.5)');g.addColorStop(1,'rgba(255,214,120,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(dr.x,dr.y,dr.r,0,6.2832);ctx.fill();}
    else{ctx.beginPath();ctx.moveTo(dr.pts[0][0],dr.pts[0][1]);for(let i=1;i<dr.pts.length;i++)ctx.lineTo(dr.pts[i][0],dr.pts[i][1]);ctx.closePath();ctx.fillStyle=css(dr.col);ctx.fill();ctx.strokeStyle=css(dr.col);ctx.lineWidth=0.4;ctx.stroke();}
  }
  if(glSkin){ctx.drawImage(glSkin,0,0,W,H);
    // speed guard: on devices where WebGL runs in software, fall back to the canvas painter
    // (frames that compiled shaders or uploaded a mesh are one-off costs and are not timed)
    var _gdt=performance.now()-_gt0;if(GLB&&GLB.skipT){GLB.skipT=false;}else{GL_EMA=GL_N?GL_EMA*0.8+_gdt*0.2:_gdt;GL_N++;}
    if(GL_N>=8&&GL_EMA>45){GLB=false;}}
  var _glowNow=Date.now();
  for(var _pi=GLOW_PULSES.length-1;_pi>=0;_pi--){
    var _gp=GLOW_PULSES[_pi];
    var _age=(_glowNow-_gp.t0)/1000,_travelDur=0.65;
    if(_age>=_travelDur){
      var _existH=GLOW_HALOS.find(function(_h){return _h.id===_gp.toId;});
      if(_existH){_existH.t0=_glowNow;}else{GLOW_HALOS.push({id:_gp.toId,t0:_glowNow});}
      GLOW_PULSES.splice(_pi,1);continue;
    }
    var _fh=organScreen[_gp.fromId],_th=organScreen[_gp.toId];
    if(!_fh||!_fh.length||!_th||!_th.length){GLOW_PULSES.splice(_pi,1);continue;}
    var _fx=0,_fy=0,_fd=0;for(const _h of _fh){_fx+=_h.x;_fy+=_h.y;_fd=Math.max(_fd,_h.d);}_fx/=_fh.length;_fy/=_fh.length;
    var _tx=0,_ty=0,_td=0;for(const _h of _th){_tx+=_h.x;_ty+=_h.y;_td=Math.max(_td,_h.d);}_tx/=_th.length;_ty/=_th.length;
    var _frac=_age/_travelDur;
    var _pulseR=Math.max(14,18*sc*0.12+10);
    // immediate bright flash at the SOURCE the instant the pulse starts, so there's always visible feedback at the origin
    if(_age<0.18){
      var _srcFade=1-(_age/0.18);
      const _sg=ctx.createRadialGradient(_fx,_fy,0,_fx,_fy,_pulseR*1.8);
      _sg.addColorStop(0,'rgba(255,250,210,'+(0.85*_srcFade)+')');_sg.addColorStop(1,'rgba(255,250,210,0)');
      ctx.fillStyle=_sg;ctx.beginPath();ctx.arc(_fx,_fy,_pulseR*1.8,0,6.2832);ctx.fill();
    }
    // trailing comet: a short fading tail behind the traveling pulse
    for(var _tr=3;_tr>=0;_tr--){
      var _trailFrac=Math.max(0,_frac-_tr*0.05);
      var _trailEase=_trailFrac*_trailFrac*(3-2*_trailFrac);
      var _txp=_fx+(_tx-_fx)*_trailEase,_typ=_fy+(_ty-_fy)*_trailEase;
      var _trailAlpha=(1-_tr/4)*0.9;
      const _tg=ctx.createRadialGradient(_txp,_typ,0,_txp,_typ,_pulseR*(1-_tr*0.16));
      _tg.addColorStop(0,'rgba(255,240,180,'+_trailAlpha+')');_tg.addColorStop(1,'rgba(255,240,180,0)');
      ctx.fillStyle=_tg;ctx.beginPath();ctx.arc(_txp,_typ,_pulseR*(1-_tr*0.16),0,6.2832);ctx.fill();
    }
  }
  for(var _hi=GLOW_HALOS.length-1;_hi>=0;_hi--){
    var _gh=GLOW_HALOS[_hi];
    var _age2=(_glowNow-_gh.t0)/1000,_haloDur=4.0;
    if(_age2>=_haloDur){GLOW_HALOS.splice(_hi,1);continue;}
    var _hs=organScreen[_gh.id];
    if(!_hs||!_hs.length){GLOW_HALOS.splice(_hi,1);continue;}
    var _hx=0,_hy=0;for(const _h of _hs){_hx+=_h.x;_hy+=_h.y;}_hx/=_hs.length;_hy/=_hs.length;
    var _pulse=0.75+0.25*Math.sin(_glowNow*0.006+_hi);
    var _fadeOut=_age2>_haloDur-1?(_haloDur-_age2):1;
    var _baseR=Math.max(26,30*sc*0.12+22);
    // bright impact flash right when the halo begins, then settle into the sustained pulse
    var _impact=_age2<0.25?(1-_age2/0.25):0;
    var _r=_baseR*_pulse*(1+_impact*0.9);
    const _hg=ctx.createRadialGradient(_hx,_hy,1,_hx,_hy,_r);
    _hg.addColorStop(0,'rgba(130,225,255,'+Math.min(1,(0.72+_impact*0.28)*_fadeOut)+')');
    _hg.addColorStop(0.55,'rgba(120,220,255,'+(0.4*_fadeOut)+')');
    _hg.addColorStop(1,'rgba(120,220,255,0)');
    ctx.fillStyle=_hg;ctx.beginPath();ctx.arc(_hx,_hy,_r,0,6.2832);ctx.fill();
    // crisp bright core so it reads clearly even on a small screen
    ctx.fillStyle='rgba(210,245,255,'+(0.85*_fadeOut)+')';
    ctx.beginPath();ctx.arc(_hx,_hy,Math.max(3,_baseR*0.14),0,6.2832);ctx.fill();
  }
  window._organScreen=organScreen;
  if(selected){const o=ORGANS.find(x=>x.id===selected);const hs=organScreen[selected];if(o&&hs&&hs.length){let cx=0,cy=0;for(const h of hs){cx+=h.x;cy+=h.y;}cx/=hs.length;cy/=hs.length;ctx.font='600 13px "IBM Plex Sans",Roboto,sans-serif';const label=o.name.split(' — ')[0].split(' (')[0];const w=ctx.measureText(label).width+18;ctx.fillStyle='rgba(10,16,26,.85)';ctx.strokeStyle='#5cc8d6';ctx.lineWidth=1;roundRect(ctx,cx-w/2,cy-42,w,22,6);ctx.fill();ctx.stroke();ctx.fillStyle='#e7edf5';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,cx,cy-31);ctx.textAlign='left';}}
}
function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
var lastTickT=Date.now(), DT=1/60;
function tick(){
 var _now=Date.now(); DT=Math.min(0.25,Math.max(0,(_now-lastTickT)/1000)); lastTickT=_now;
 if(homeActive){
   var need=false;
   if(autoSpin&&!drag){angY+=0.36*DT;need=true;}
   if(!drag&&Math.abs(vel)>0.0002){angY+=vel*DT*60;vel*=Math.pow(0.94,DT*60);need=true;}
   if(need||GLOW_PULSES.length||GLOW_HALOS.length)draw();
 } else {
   glandAng+=0.72*DT;
   advanceGoi();
   var cv=document.getElementById('gc-'+activeTab);if(cv&&cv.style.display!=='none')renderGland(cv,activeTab,glandAng);
   var px=document.getElementById('px-'+activeTab);if(px)drawParticles(px,activeTab);
   animateImage(activeTab);
   if(activeTab==='ovaries'){var ovc=document.getElementById('ov-cv');if(ovc)drawOvulation(ovc);var devc=document.getElementById('dev-cv');if(devc)drawBreastDev(devc);}
   if(activeTab==='testes'){var spc=document.getElementById('sperm-cv');if(spc)drawSpermatogenesis(spc);}
   if(DEMO[activeTab])DEMO[activeTab]();
 }
 requestAnimationFrame(tick);
}
function pick(mx,my){const os=window._organScreen||{};let best=null,bd=-1e9;for(const id in os){for(const h of os[id]){const dx=(mx-h.x)/h.rx,dy=(my-h.y)/h.ry;if(dx*dx+dy*dy<=1&&h.d>bd){bd=h.d;best=id;}}}return best;}
function localXY(e){const r=view.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return[t.clientX-r.left,t.clientY-r.top];}
var longPressTimer=null,longPressFired=false,longPressId=null;
var activePtrs=0;
view.addEventListener('contextmenu',e=>e.preventDefault()); // no long-press menu on touch panels
view.addEventListener('pointerdown',e=>{if(e.isPrimary)activePtrs=0;activePtrs++;if(activePtrs>1){drag=false;moved=99;if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}return;}drag=true;moved=0;const a=localXY(e);lastX=a[0];lastY=a[1];vel=0;view.setPointerCapture(e.pointerId);longPressFired=false;const hitId=pick(a[0],a[1]);if(hitId){longPressId=hitId;longPressTimer=setTimeout(()=>{if(moved<6){longPressFired=true;showOrganCard(longPressId);triggerTargetGlow(longPressId);}},450);}});
view.addEventListener('pointermove',e=>{if(activePtrs>1)return;const a=localXY(e),x=a[0],y=a[1];if(drag){const dx=x-lastX,dy=y-lastY;moved+=Math.abs(dx)+Math.abs(dy);if(longPressTimer&&moved>=6){clearTimeout(longPressTimer);longPressTimer=null;}angY+=dx*0.008;angX+=dy*0.006;vel=dx*0.008;if(angX>0.78)angX=0.78;if(angX<-0.78)angX=-0.78;lastX=x;lastY=y;draw();}else{const id=pick(x,y);const tip=document.getElementById('tip');if(id!==hoverId){hoverId=id;draw();}if(id){const o=ORGANS.find(z=>z.id===id);tip.style.display='block';tip.style.left=x+'px';tip.style.top=y+'px';tip.textContent=o.name.split(' — ')[0].split(' (')[0];view.style.cursor='pointer';}else{tip.style.display='none';view.style.cursor='grab';}}});
function endDrag(e){activePtrs=Math.max(0,activePtrs-1);if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}if(drag){drag=false;if(longPressFired){longPressFired=false;return;}if(moved<6){const a=localXY(e);const id=pick(a[0],a[1]);if(id)openGlandTab(id);}}}
view.addEventListener('pointerup',endDrag);
view.addEventListener('pointercancel',()=>{activePtrs=Math.max(0,activePtrs-1);drag=false;if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}});
view.addEventListener('pointerleave',()=>{hoverId=null;document.getElementById('tip').style.display='none';});
view.addEventListener('wheel',e=>{e.preventDefault();zoom*=e.deltaY<0?1.08:0.93;if(zoom<0.6)zoom=0.6;if(zoom>2.6)zoom=2.6;draw();},{passive:false});
let pd=0;view.addEventListener('touchmove',e=>{if(e.touches.length===2){e.preventDefault();const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;const d=Math.hypot(dx,dy);if(pd){zoom*=d/pd;if(zoom<0.6)zoom=0.6;if(zoom>2.6)zoom=2.6;}pd=d;draw();}},{passive:false});
view.addEventListener('touchend',()=>{pd=0;});

/* ===== list + toggles ===== */
const listEl=document.getElementById('list');
var GLOW_PULSES=[],GLOW_HALOS=[];
function triggerTargetGlow(sourceId){
  var o=ORGANS.find(function(x){return x.id===sourceId;});
  if(!o||!o.targets)return;
  var now=Date.now();
  o.targets.forEach(function(t){
    if(t.sexReq&&t.sexReq!==sex)return;
    var to=ORGANS.find(function(x){return x.id===t.id;});
    if(!to||!visible(to))return;
    var existingPulse=GLOW_PULSES.find(function(p){return p.toId===t.id;});
    if(existingPulse){existingPulse.t0=now;existingPulse.fromId=sourceId;existingPulse.hormone=t.hormone;return;}
    var existingHalo=GLOW_HALOS.find(function(h){return h.id===t.id;});
    if(existingHalo){existingHalo.t0=now;return;}
    GLOW_PULSES.push({fromId:sourceId,toId:t.id,t0:now,hormone:t.hormone});
  });
}
var orgCardHideTimer=null;
function showOrganCard(id){
  var o=ORGANS.find(function(x){return x.id===id;});
  if(!o)return;
  var card=document.getElementById('orgCard');
  if(!card)return;
  var html='<div class="ocTitle">'+o.name+'</div>';
  if(o.origin){
    html+='<div class="ocSection">Target organ</div>';
    html+='<div class="ocList">Responds to <b>'+o.hormone+'</b><br>released by the <b>'+o.origin+'</b></div>';
  } else {
    var core=o.core||[], extra=o.extra||[];
    if(core.length){
      html+='<div class="ocSection">Hormones released here</div>';
      html+='<div class="ocList">'+core.join('<br>')+'</div>';
    }
    if(extra.length){
      html+='<div class="ocSection">Also released here</div>';
      html+='<div class="ocList ocExtra">'+extra.join('<br>')+'</div>';
      html+='<div class="ocNote">Extra info \u2014 beyond the core Class 10 syllabus.</div>';
    }
  }
  card.innerHTML=html;
  card.classList.add('show');
  if(orgCardHideTimer)clearTimeout(orgCardHideTimer);
  orgCardHideTimer=setTimeout(function(){card.classList.remove('show');},5000);
}
function buildList(){listEl.innerHTML='';ORGANS.forEach(o=>{if(!visible(o))return;const d=document.createElement('div');d.className='item'+(selected===o.id?' sel':'');d.innerHTML='<span class="dot" style="background:'+o.color+'"></span><span>'+o.name.replace(' — ',' – ')+'</span>';d.onclick=()=>openGlandTab(o.id);d.onmouseenter=()=>{hoverId=o.id;draw();};d.onmouseleave=()=>{hoverId=null;draw();};listEl.appendChild(d);});}
document.getElementById('sexSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;sex=b.dataset.sex;rebuildBody(sex);tabs.slice().forEach(function(gg){if(gg==='home')return;var o=ORGANS.find(function(x){return x.id===gg;});if(o&&o.grp!=='all'&&o.grp!==sex)closeTab(gg);});const kids=e.currentTarget.children;for(let i=0;i<kids.length;i++){kids[i].classList.toggle('on',kids[i]===b);kids[i].classList.toggle('f',kids[i]===b&&sex==='female');}if(selected){const o=ORGANS.find(z=>z.id===selected);if(o&&o.grp!=='all'&&o.grp!==sex)selected=null;}buildList();draw();});
const spinBtn=document.getElementById('spinBtn');spinBtn.onclick=()=>{autoSpin=!autoSpin;spinBtn.classList.toggle('active',autoSpin);};
const xrayBtn=document.getElementById('xrayBtn');xrayBtn.onclick=()=>{XRAY=!XRAY;xrayBtn.classList.toggle('active',XRAY);draw();};
document.getElementById('resetBtn').onclick=()=>{angX=0.05;angY=0;zoom=1;vel=0;draw();};


/* ================= TAB SYSTEM + GLAND FUNCTION LABS ================= */
// ---- Paste your Supabase public image URLs here (leave "" to show the live 3D model) ----
var SUPABASE_IMAGES = {
  pituitary:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pituitary/Pitutary%20Gland.png",
  pineal:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pineal/Pineal%20Gland.png",
  thyroid:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Thyroid/Thyroid%20gland.png",
  parathyroid:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Parathyroid/Parathyroid%20Gland.png",
  adrenal:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Adrenal%20Gland/Adrenal%20Gland.png",
  pancreas:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pancreas/Pancreas.png",
  ovaries:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Ovary/Ovary.png",
  testes:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Testis/Testis.png",
  uterus:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Uterus/Uterus.png",
  larynx:"https://raw.githubusercontent.com/Dray-Ashcroft/Corpus-Glandula/refs/heads/main/assets/Larynx/Larynx.png",
  bone:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Haversian%20Canal/Haversian%20Canal.png",
  vasopressin:"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Collecting%20Duct/Collecting%20Duct%20TS.png"
};
// e.g. pancreas:"https://YOURPROJECT.supabase.co/storage/v1/object/public/glands/pancreas.png"
function serializeImages(obj){
  var keys=ORGANS.map(function(o){return o.id;}).concat(['larynx','bone','vasopressin']);
  var esc=function(s){return String(s||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"');};
  var lines=keys.map(function(k){return '  '+k+':"'+esc(obj[k]||'')+'"';});
  return 'var SUPABASE_IMAGES = {\n'+lines.join(',\n')+'\n};';
}
/* ===== save: HTML snapshot + JSON settings ===== */
var SNAPSHOT_STATE={"app":"Corpus Glandula","kind":"settings","version":1,"savedAt":"2026-10-20T13:12:26.820Z","view":{"sex":"male","xray":false,"autoSpin":false,"angX":0.345,"angY":0.03,"zoom":1},"images":{"pituitary":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pituitary/Pitutary%20Gland.png","pineal":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pineal/Pineal%20Gland.png","thyroid":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Thyroid/Thyroid%20gland.png","parathyroid":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Parathyroid/Parathyroid%20Gland.png","adrenal":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Adrenal%20Gland/Adrenal%20Gland.png","pancreas":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Pancreas/Pancreas.png","ovaries":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Ovary/Ovary.png","testes":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Testis/Testis.png","uterus":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Uterus/Uterus.png","larynx":"https://raw.githubusercontent.com/Dray-Ashcroft/Corpus-Glandula/refs/heads/main/assets/Larynx/Larynx.png","bone":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Haversian%20Canal/Haversian%20Canal.png","vasopressin":"https://raw.githubusercontent.com/Dray-Ashcroft/Cor-Gl/refs/heads/main/assets/Collecting%20Duct/Collecting%20Duct%20TS.png"}}; // filled in by "Save HTML snapshot"; restored on open
// split build: settings carried by a saved index.html (see exportHTML fallback)
if(typeof CG_OVERRIDE!=='undefined'&&CG_OVERRIDE&&CG_OVERRIDE.state){SNAPSHOT_STATE=CG_OVERRIDE.state;var _oi=CG_OVERRIDE.state.images||{};for(var _ok in _oi){if(_oi[_ok])SUPABASE_IMAGES[_ok]=_oi[_ok];}}
function captureState(){
  var imgs={};for(var k in SUPABASE_IMAGES){if(SUPABASE_IMAGES[k])imgs[k]=SUPABASE_IMAGES[k];}
  return {app:'Corpus Glandula',kind:'settings',version:1,savedAt:new Date().toISOString(),
    view:{sex:sex,xray:XRAY,autoSpin:autoSpin,angX:+angX.toFixed(4),angY:+(angY%6.28319).toFixed(4),zoom:+zoom.toFixed(3)},
    images:imgs};
}
function applyState(st){
  if(!st||!st.view)return;var v=st.view;
  if(v.sex==='male'||v.sex==='female'){var sb=document.querySelector('#sexSeg button[data-sex="'+v.sex+'"]');if(sb&&v.sex!==sex)sb.click();}
  if(typeof v.xray==='boolean'&&v.xray!==XRAY)document.getElementById('xrayBtn').click();
  if(typeof v.autoSpin==='boolean'&&v.autoSpin!==autoSpin)document.getElementById('spinBtn').click();
  if(isFinite(v.angX))angX=Math.max(-0.78,Math.min(0.78,v.angX));
  if(isFinite(v.angY))angY=v.angY;
  if(isFinite(v.zoom))zoom=Math.max(0.6,Math.min(2.6,v.zoom));
  draw();
}
function stamp(){var d=new Date(),p=function(n){return(n<10?'0':'')+n;};return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes());}
function downloadText(text,type,name){
  var blob=new Blob([text],{type:type}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},1500);
}
/* Snapshot = one self-contained HTML file with your image links + current view.
   This build is split (index.html + css/ + js/), so the snapshot re-assembles a single file by
   fetching the files marked data-inline and inlining them (works on GitHub Pages / any web server).
   When the app is opened straight from disk (file://) browsers block that, so it instead saves an
   index.html carrying your settings, to be placed next to the css/ and js/ folders. */
var OVERRIDE_RE=/<script id="cgOverride">[\s\S]*?<\/script>\n?/;
function bakeConfig(template){
  var re=/var SUPABASE_IMAGES = \{[\s\S]*?\};/, reS=/var SNAPSHOT_STATE=[^\n]*?; \/\/ filled in/;
  if(!re.test(template)||!reS.test(template))throw new Error('could not locate the config in the page template.');
  var st=JSON.stringify(captureState()).replace(/</g,'\\u003c');
  return template.replace(re,function(){return serializeImages(SUPABASE_IMAGES);}).replace(reS,function(){return 'var SNAPSHOT_STATE='+st+'; // filled in';});
}
function exportHTML(){
  var parts=Array.prototype.slice.call(document.querySelectorAll('link[data-inline],script[data-inline]'));
  if(!parts.length){ // already a single file
    try{downloadText(bakeConfig(PRISTINE_HTML),'text/html','corpus-glandula-snapshot-'+stamp()+'.html');}catch(e){alert('Snapshot failed: '+e.message);}
    return;
  }
  var urlOf=function(el){return el.getAttribute('href')||el.getAttribute('src');};
  var escRe=function(t){return t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');};
  Promise.all(parts.map(function(el){return fetch(urlOf(el)).then(function(r){if(!r.ok)throw new Error(urlOf(el));return r.text();});}))
  .then(function(texts){
    var html=PRISTINE_HTML.replace(OVERRIDE_RE,'');
    parts.forEach(function(el,i){
      var u=escRe(urlOf(el)),body=texts[i];
      if(el.tagName==='LINK'){html=html.replace(new RegExp('<link[^>]*href="'+u+'"[^>]*>'),function(){return '<style>\n'+body+'</style>';});}
      else{body=body.replace(/<\/script/gi,'<\\/script');html=html.replace(new RegExp('<script[^>]*src="'+u+'"[^>]*></script>'),function(){return '<script>\n'+body+'</script>';});}
    });
    downloadText(bakeConfig(html),'text/html','corpus-glandula-snapshot-'+stamp()+'.html');
  })
  .catch(function(){
    try{
      var st=JSON.stringify({state:captureState()}).replace(/</g,'\\u003c');
      var html=PRISTINE_HTML.replace(OVERRIDE_RE,'').replace(/<script[^>]*src="js\/models\.js"[^>]*><\/script>/,function(m){return '<script id="cgOverride">var CG_OVERRIDE='+st+';</script>\n'+m;});
      downloadText(html,'text/html','index.html');
      alert('Saved as index.html.\n\nThis page was opened directly from disk, so the browser does not allow building a single-file snapshot. Put this index.html in the Corpus Glandula folder (next to the css and js folders), replacing the old one.\n\nFor a single-file snapshot, open the app from GitHub Pages and press the button there.');
    }catch(e){alert('Snapshot failed: '+e.message);}
  });
}
function exportJSON(){
  try{downloadText(JSON.stringify(captureState(),null,2),'application/json','corpus-glandula-settings-'+stamp()+'.json');}
  catch(e){alert('JSON save failed: '+e.message);}
}

var tabs=['home'], activeTab='home';
var homeActive=true, glandAng=0, DEMO={}, PST={};
var tabbarEl=document.getElementById('tabbar');
var panelsEl=document.getElementById('panels');

function tabLabel(id){if(id==='home')return 'Body';var o=ORGANS.find(function(x){return x.id===id;});return o?o.name.split(' (')[0]:id;}
function renderTabbar(){
  tabbarEl.innerHTML='';
  tabs.forEach(function(id){
    var t=document.createElement('div');t.className='tab'+(id===activeTab?' active':'');
    t.innerHTML='<span class="tlbl">'+(id==='home'?'&#127968; ':'')+tabLabel(id)+'</span>'+(id==='home'?'':'<span class="tclose">&times;</span>');
    t.querySelector('.tlbl').onclick=function(){activateTab(id);};
    if(id!=='home')t.querySelector('.tclose').onclick=function(e){e.stopPropagation();closeTab(id);};
    tabbarEl.appendChild(t);
  });
}
function activateTab(id){
  activeTab=id;homeActive=(id==='home');
  document.getElementById('view-home').classList.toggle('active',homeActive);
  var ch=panelsEl.children;for(var i=0;i<ch.length;i++)ch[i].classList.toggle('active',ch[i].id==='panel-'+id);
  renderTabbar();
  if(homeActive){resize();draw();}
}
function openGlandTab(id){if(tabs.indexOf(id)<0){tabs.push(id);buildGlandPanel(id);}activateTab(id);}
function closeTab(id){var i=tabs.indexOf(id);if(i<0)return;tabs.splice(i,1);var p=document.getElementById('panel-'+id);if(p)p.remove();if(activeTab===id)activateTab('home');else renderTabbar();}

var LS_KEY='endo_c10_images_v1';
function loadSavedImages(){
  try{var raw=localStorage.getItem(LS_KEY);if(!raw)return;var saved=JSON.parse(raw);
    for(var k in saved){if(saved[k])SUPABASE_IMAGES[k]=saved[k];}
  }catch(e){/* localStorage unavailable (e.g. file:// in some browsers) — fine, just skip */}
}
function persistImages(){
  try{localStorage.setItem(LS_KEY,JSON.stringify(SUPABASE_IMAGES));}catch(e){/* ignore */}
}
function toggleUrlEdit(id,hasImage){
  var row=document.getElementById('urlrow-'+id);
  var pencilRow=document.getElementById('pencilrow-'+id);
  if(!row)return;
  if(hasImage){row.style.display='none';if(pencilRow)pencilRow.classList.add('show');}
  else{row.style.display='flex';if(pencilRow)pencilRow.classList.remove('show');}
}
function wirePencilButton(id){
  var p=document.getElementById('pencil-'+id);
  if(!p)return;
  p.onclick=function(){toggleUrlEdit(id,false);};
}
var PENCIL_SVG='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5 16.5 6.5 7 16 3 17 4 13 13.5 3.5Z"/></svg>';
function pencilRowHTML(id,hasUrl){
  return '<div class="pencilRow'+(hasUrl?' show':'')+'" id="pencilrow-'+id+'"><button class="urlPencil" id="pencil-'+id+'" title="Edit image URL">'+PENCIL_SVG+'</button></div>';
}
function imgArea(id){
  var url=SUPABASE_IMAGES[id]||'';
  var fx='<canvas class="fx" id="px-'+id+'"></canvas>';
  return '<div class="imgwrap">'+
    '<img id="im-'+id+'" alt="'+tabLabel(id)+'" style="display:none">'+       /* src set after load succeeds (see loadPanelImage) */
    '<canvas class="glandcv" id="gc-'+id+'" style="display:block"></canvas>'+
    fx+
    '<div class="imgph" id="ph-'+id+'" style="display:none">Image did not load &mdash; check the URL, then try again.</div>'+
    '</div>'+
    '<div class="urlrow" id="urlrow-'+id+'" style="display:'+(url?'none':'flex')+'">'+
      '<input type="text" id="url-'+id+'" class="urlin" placeholder="Paste image URL (e.g. from Supabase)" value="'+url.replace(/"/g,'&quot;')+'" autocomplete="off" spellcheck="false">'+
      '<button class="urlreset" id="urlrs-'+id+'" title="Remove image, show 3D model">Reset</button>'+
    '</div>'+
    pencilRowHTML(id,!!url);
}
function applyBoneURL(url){
  url=(url||'').trim();
  SUPABASE_IMAGES.bone=url;persistImages();
  var img=document.getElementById('im-bone');
  if(!img)return;
  if(!url){img.style.display='none';img.removeAttribute('src');toggleUrlEdit('bone',false);return;}
  loadImageRobust(img,url,
    function(){img.style.display='block';toggleUrlEdit('bone',true);},
    function(){img.style.display='none';toggleUrlEdit('bone',false);}
  );
}
function wireBoneUrlField(){
  var inp=document.getElementById('url-bone'),rs=document.getElementById('urlrs-bone');
  if(!inp)return;
  var apply=function(){applyBoneURL(inp.value);};
  var deb=null;
  inp.addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(apply,400);});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'){clearTimeout(deb);apply();}});
  if(rs)rs.onclick=function(){inp.value='';applyBoneURL('');};
  wirePencilButton('bone');
}
function applyVasoURL(url){
  url=(url||'').trim();
  SUPABASE_IMAGES.vasopressin=url;persistImages();
  var img=document.getElementById('im-vaso'),ph=document.getElementById('ph-vaso');
  if(!img||!ph)return;
  if(!url){img.style.display='none';img.removeAttribute('src');ph.style.display='block';ph.textContent='Paste a kidney tubule / collecting duct image URL below to show it here.';toggleUrlEdit('vaso',false);return;}
  loadImageRobust(img,url,
    function(){img.style.display='block';ph.style.display='none';toggleUrlEdit('vaso',true);},
    function(){img.style.display='none';ph.style.display='block';ph.textContent='Image did not load \u2014 check the URL, then try again.';toggleUrlEdit('vaso',false);}
  );
}
function wireVasoUrlField(){
  var inp=document.getElementById('url-vaso'),rs=document.getElementById('urlrs-vaso');
  if(!inp)return;
  var apply=function(){applyVasoURL(inp.value);};
  var deb=null;
  inp.addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(apply,400);});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'){clearTimeout(deb);apply();}});
  if(rs)rs.onclick=function(){inp.value='';applyVasoURL('');};
  wirePencilButton('vaso');
}
function applyLarynxURL(url){
  url=(url||'').trim();
  SUPABASE_IMAGES.larynx=url;persistImages();
  var img=document.getElementById('im-larynx'),ph=document.getElementById('ph-larynx');
  if(!img||!ph)return;
  if(!url){img.style.display='none';img.removeAttribute('src');ph.style.display='block';ph.textContent='Paste a larynx diagram URL below to show a real reference image here.';toggleUrlEdit('larynx',false);return;}
  loadImageRobust(img,url,
    function(){img.style.display='block';ph.style.display='none';toggleUrlEdit('larynx',true);},
    function(){img.style.display='none';ph.style.display='block';ph.textContent='Image did not load \u2014 check the URL, then try again.';toggleUrlEdit('larynx',false);}
  );
}
function wireLarynxUrlField(){
  var inp=document.getElementById('url-larynx'),rs=document.getElementById('urlrs-larynx');
  if(!inp)return;
  var apply=function(){applyLarynxURL(inp.value);};
  var deb=null;
  inp.addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(apply,400);});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'){clearTimeout(deb);apply();}});
  if(rs)rs.onclick=function(){inp.value='';applyLarynxURL('');};
  wirePencilButton('larynx');
}
function loadImageRobust(img,url,onSuccess,onFail){
  img.onload=onSuccess;
  img.onerror=function(){
    if(typeof fetch!=='function'){onFail();return;}
    fetch(url).then(function(r){
      if(!r.ok)throw new Error('bad status '+r.status);
      return r.blob();
    }).then(function(blob){
      var objUrl=URL.createObjectURL(blob);
      img.onerror=onFail;
      img.onload=onSuccess;
      img.src=objUrl;
    }).catch(function(){onFail();});
  };
  img.src=url;
}
function applyImageURL(id,url){
  url=(url||'').trim();
  SUPABASE_IMAGES[id]=url;persistImages();
  var img=document.getElementById('im-'+id),cv=document.getElementById('gc-'+id),ph=document.getElementById('ph-'+id);
  if(!img)return;
  if(!url){img.style.display='none';img.removeAttribute('src');if(cv)cv.style.display='block';if(ph)ph.style.display='none';toggleUrlEdit(id,false);return;}
  ph.style.display='none';
  loadImageRobust(img,url,
    function(){img.style.display='block';if(cv)cv.style.display='none';toggleUrlEdit(id,true);},
    function(){img.style.display='none';if(cv)cv.style.display='block';ph.style.display='block';toggleUrlEdit(id,false);}
  );
}
/* Saved image for a gland tab: show the live 3D model until the picture has really loaded.
   If it can't load (classroom offline, expired link) the 3D model stays, with a short note. */
function loadPanelImage(id){
  var url=SUPABASE_IMAGES[id];if(!url)return;
  var img=document.getElementById('im-'+id),cv=document.getElementById('gc-'+id),ph=document.getElementById('ph-'+id);if(!img)return;
  toggleUrlEdit(id,true);
  loadImageRobust(img,url,
    function(){img.style.display='block';if(cv)cv.style.display='none';if(ph)ph.style.display='none';},
    function(){img.style.display='none';img.removeAttribute('src');if(cv)cv.style.display='block';
      if(ph){ph.textContent='Saved image could not load (offline?) \u2014 showing the 3D model.';ph.style.display='block';setTimeout(function(){ph.style.display='none';},4000);}});
}
function wireUrlField(id){
  var inp=document.getElementById('url-'+id),rs=document.getElementById('urlrs-'+id);
  if(!inp)return;
  var apply=function(){applyImageURL(id,inp.value);};
  var deb=null;
  inp.addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(apply,400);}); // debounced: paste/typed URLs settle before we try loading
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'){clearTimeout(deb);apply();}});
  if(rs)rs.onclick=function(){inp.value='';applyImageURL(id,'');};
  wirePencilButton(id);
}
function wireScrollHint(panelEl){
  var hint=panelEl.querySelector('.scrollhint');
  if(!hint) return;
  function check(){
    var atBottom=(panelEl.scrollTop+panelEl.clientHeight) >= (panelEl.scrollHeight-24);
    hint.classList.toggle('hide', atBottom);
  }
  panelEl.addEventListener('scroll', check);
  check();
  setTimeout(check, 50); // re-check once layout has settled (images/canvases can change scrollHeight)
}
function buildGlandPanel(id){
  var o=ORGANS.find(function(x){return x.id===id;});
  var div=document.createElement('div');div.className='panel';div.id='panel-'+id;
  div.innerHTML='<div class="pcol pleft">'+imgArea(id)+'</div>'+
   '<div class="pcol pright">'+
   '<div class="hlabel">Hormone</div><h2 class="hname">'+o.hormone+'</h2>'+
   '<div class="origin">Released by the <b>'+(o.origin||o.name)+'</b></div>'+
   '<div class="pfield"><div class="pk">Functions</div><div class="pv">'+o.func+'</div></div>'+
   '<div class="pfield"><div class="pk">Remember</div><div class="pv">'+o.note+'</div></div>'+
   '<div class="lab" id="lab-'+id+'"></div></div>'+
   '<div class="scrollhint" id="scrollhint-'+id+'"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8 L10 13 L15 8"/></svg></div>';
  panelsEl.appendChild(div);
  buildLab(id,div.querySelector('#lab-'+id));
  wireScrollHint(div);
  wireUrlField(id);
  loadPanelImage(id);
}
function gaugeHTML(label){return '<div class="gauge"><div class="glabel">'+label+'</div><div class="gbarwrap"><div class="gbar"></div></div><div class="gval"></div></div>';}
function setGauge(root,val,min,max,zones,unit){
  var bar=root.querySelector('.gbar'),valEl=root.querySelector('.gval');
  var pct=(val-min)/(max-min);if(pct<0)pct=0;if(pct>1)pct=1;
  var z=zones[zones.length-1];for(var i=0;i<zones.length;i++){if(val>=zones[i][0]&&val<zones[i][1]){z=zones[i];break;}}
  bar.style.width=(pct*100)+'%';bar.style.background=z[2];
  valEl.textContent=Math.round(val)+' '+unit+'  ('+z[3]+')';valEl.style.color=z[2];
}
function slider(id,label,min,max,val){return '<div class="ctl"><label>'+label+'</label><input type="range" id="'+id+'" min="'+min+'" max="'+max+'" value="'+val+'"></div>';}
function drawSpark(cv,hist,min,max){
  var rect=cv.getBoundingClientRect();var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));
  if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var y1=h-(72-min)/(max-min)*h,y2=h-(110-min)/(max-min)*h;
  g.fillStyle='rgba(95,206,143,0.14)';g.fillRect(0,y2,w,y1-y2);
  g.strokeStyle='#e6795a';g.lineWidth=2;g.beginPath();
  for(var i=0;i<hist.length;i++){var x=i/119*w,y=h-(hist[i]-min)/(max-min)*h;if(i===0)g.moveTo(x,y);else g.lineTo(x,y);}
  g.stroke();
}
function buildLab(id,el){
  if(id==='pancreas'){
    el.innerHTML='<div class="labtitle">Try it &mdash; control blood sugar</div>'+
      '<div class="seg2"><button id="horm-ins" class="on">Insulin</button><button id="horm-glu">Glucagon</button></div>'+
      '<div id="ins-panel">'+slider('ins-s','Insulin released by pancreas',0,100,40)+'<button class="labbtn" id="meal-b">&#127834; Eat sugary food</button></div>'+
      '<div id="glu-panel" style="display:none">'+slider('glu-s','Glucagon released by pancreas',0,100,40)+'<button class="labbtn" id="fast-b">&#8987; Skip a meal (fast)</button></div>'+
      gaugeHTML('Blood glucose')+'<canvas class="spark" id="spark-pan"></canvas>'+
      '<div class="labhint" id="pan-hint">Drag insulin up &rarr; blood sugar falls. Keep insulin low &rarr; sugar climbs into the diabetes zone.</div>';
    var st={g:95,ins:40,glu:40,meal:0,fast:0,hist:[],mode:'ins'};PST[id]=st;
    var gr=el.querySelector('.gauge'),sp=el.querySelector('#spark-pan'),hint=el.querySelector('#pan-hint');
    var insBtn=el.querySelector('#horm-ins'),gluBtn=el.querySelector('#horm-glu');
    var insPanel=el.querySelector('#ins-panel'),gluPanel=el.querySelector('#glu-panel');
    el.querySelector('#ins-s').oninput=function(e){st.ins=+e.target.value;};
    el.querySelector('#glu-s').oninput=function(e){st.glu=+e.target.value;};
    el.querySelector('#meal-b').onclick=function(){st.meal+=75;};
    el.querySelector('#fast-b').onclick=function(){st.fast+=55;};
    insBtn.onclick=function(){
      st.mode='ins';st.glu=40;st.fast=0;
      insBtn.classList.add('on');gluBtn.classList.remove('on');
      insPanel.style.display='block';gluPanel.style.display='none';
      hint.innerHTML='Drag insulin up &rarr; blood sugar falls. Keep insulin low &rarr; sugar climbs into the diabetes zone.';
    };
    gluBtn.onclick=function(){
      st.mode='glu';st.ins=40;st.meal=0;
      gluBtn.classList.add('on');insBtn.classList.remove('on');
      gluPanel.style.display='block';insPanel.style.display='none';
      hint.innerHTML='<b>Glucagon raises blood sugar</b> &mdash; the opposite of insulin. Skip a meal to see sugar dip, then drag glucagon up to watch it get pulled back up.';
    };
    DEMO[id]=function(){
      var tgt=90+st.meal-st.fast-(st.ins-40)*1.5+(st.glu-40)*1.5;
      if(tgt<45)tgt=45;if(tgt>300)tgt=300;
      st.g+=(tgt-st.g)*(1-Math.exp(-3.7*DT));
      st.meal*=Math.pow(0.985,Math.max(1,DT*60));
      st.fast*=Math.pow(0.985,Math.max(1,DT*60));
      ACT.pancreas=(st.mode==='ins'?st.ins:st.glu)/100;
      setGauge(gr,st.g,40,300,[[40,72,'#5aa9e6','low'],[72,110,'#5fce8f','normal'],[110,300,'#e6795a','high']],'mg/dL');
      st.hist.push(st.g);if(st.hist.length>120)st.hist.shift();drawSpark(sp,st.hist,40,300);
    };
  
} else if(id==='thyroid'){
    el.innerHTML='<div class="labtitle">Try it &mdash; thyroxine &amp; metabolism</div>'+slider('t-s','Thyroxine level',0,100,50)+gaugeHTML('Metabolic rate')+'<div class="labhint">More thyroxine &rarr; faster metabolism. Too little &rarr; sluggish and slow.</div>'+
      '<div class="labtitle" style="margin-top:18px">Iodine &amp; goitre</div><div class="seg2"><button id="io-ok" class="on">Iodine present</button><button id="io-no">Iodine deficient</button></div><div id="io-cap" class="labhint">Iodine is needed to make thyroxine.</div>';
    var g=el.querySelector('.gauge');var up=function(v){ACT.thyroid=v/100;setGauge(g,60+v*1.0,60,170,[[60,90,'#5aa9e6','slow'],[90,120,'#5fce8f','normal'],[120,170,'#e6795a','fast']],'%');};
    el.querySelector('#t-s').oninput=function(e){up(+e.target.value);};up(50);
    var iok=el.querySelector('#io-ok'),ino=el.querySelector('#io-no'),iocap=el.querySelector('#io-cap');
    iok.onclick=function(){THYSWELL=0;iok.classList.add('on');ino.classList.remove('on');iocap.innerHTML='Iodine present &mdash; thyroxine is made normally and the gland stays its normal size.';};
    ino.onclick=function(){THYSWELL=1;ino.classList.add('on');iok.classList.remove('on');iocap.innerHTML='<b>Iodine deficient!</b> The thyroid cannot make thyroxine, so it keeps getting stimulated and <b>swells into a goitre</b> (visible neck swelling).';};
  } else if(id==='parathyroid'){
    el.innerHTML='<div class="labtitle">Try it &mdash; PTH &amp; blood calcium</div>'+slider('p-s','Parathormone (PTH)',0,100,50)+gaugeHTML('Blood calcium')+
      '<div class="subimg" id="boneimgwrap"><img id="im-bone" src="" alt="Bone" style="display:none;"><canvas class="overlay" id="bone-cv"></canvas></div>'+
      '<div class="urlrow" id="urlrow-bone"><input type="text" id="url-bone" class="urlin" placeholder="Optional: paste a real bone/Haversian canal image URL" value="" autocomplete="off" spellcheck="false"><button class="urlreset" id="urlrs-bone" title="Remove image">Reset</button></div>'+
      pencilRowHTML('bone',!!(SUPABASE_IMAGES.bone))+
      '<div class="labhint">More PTH &rarr; more calcium moved from bones into the blood.</div>';
    var g2=el.querySelector('.gauge');var up2=function(v){ACT.parathyroid=v/100;setGauge(g2,7+v*0.05,7,13,[[7,8.5,'#5aa9e6','low'],[8.5,10.5,'#5fce8f','normal'],[10.5,13,'#e6795a','high']],'mg/dL');};
    el.querySelector('#p-s').oninput=function(e){up2(+e.target.value);};up2(50);
    CALC_PARTICLES=[];CALC_SPAWN_ACC=0;
    DEMO[id]=function(){var bc=document.getElementById('bone-cv');if(bc)drawBoneCalcium(bc,+el.querySelector('#p-s').value);};
    applyBoneURL(SUPABASE_IMAGES.bone||'');
    wireBoneUrlField();
  } else if(id==='adrenal'){
    el.innerHTML='<div class="labtitle">Try it &mdash; fight or flight</div><button class="labbtn" id="fear-b">&#9889; Sudden fright!</button>'+gaugeHTML('Heart rate')+'<canvas class="heartcv" id="heart-cv"></canvas><div class="labhint">Press the button: adrenaline spikes the heart rate, then it slowly settles back to normal.</div>';
    var st2={hr:72};PST[id]=st2;var g3=el.querySelector('.gauge');
    el.querySelector('#fear-b').onclick=function(){st2.hr=152;};
    DEMO[id]=function(){st2.hr+=(72-st2.hr)*(1-Math.exp(-1.83*DT));ADRHR=st2.hr;ACT.adrenal=Math.max(0,Math.min(1,(st2.hr-72)/80));setGauge(g3,st2.hr,60,170,[[60,100,'#5fce8f','calm'],[100,140,'#e6b04a','alert'],[140,170,'#e6795a','racing']],'bpm');var hc=document.getElementById('heart-cv');if(hc)drawHeart(hc,st2.hr);};
  } else if(id==='pituitary'){
    el.innerHTML='<div class="labtitle">Try it &mdash; growth hormone</div>'+slider('g-s','Growth Hormone (GH)',0,100,50)+gaugeHTML('Body growth')+'<canvas class="figcv" id="gh-fig"></canvas><div class="labhint">Drag GH: too little in childhood &rarr; dwarfism; too much &rarr; gigantism.</div>'+
      '<div class="labtitle" style="margin-top:18px">Also released here &mdash; Vasopressin (ADH)</div>'+
      '<div class="labhint">Vasopressin (antidiuretic hormone) is made in the hypothalamus but stored and released by the pituitary. It acts on the kidney tubules, making them reabsorb more <b>water</b> back into the blood \u2014 this concentrates the urine and stops the body losing too much water. Too little ADH causes excess dilute urine (as in diabetes insipidus); more ADH means the body holds on to water.</div>'+
      '<div class="subimg" id="vasoimgwrap"><img id="im-vaso" src="" alt="Kidney tubule" style="display:none;"><canvas class="overlay" id="vaso-cv"></canvas><div class="subimgph" id="ph-vaso">Paste a kidney tubule / collecting duct image URL below to show it here.</div></div>'+
      '<div class="urlrow" id="urlrow-vaso"><input type="text" id="url-vaso" class="urlin" placeholder="Paste kidney tubule image URL" value="" autocomplete="off" spellcheck="false"><button class="urlreset" id="urlrs-vaso" title="Remove image">Reset</button></div>'+
      pencilRowHTML('vaso',!!(SUPABASE_IMAGES.vasopressin))+
      '<div class="labtitle" style="margin-top:18px">Try it \u2014 water reabsorption</div>'+
      slider('adh-s','Vasopressin (ADH) level',0,100,30)+
      '<div class="labhint">Drag ADH up: more aquaporin channels open in the collecting duct wall, and more water moves out of the tubule and back into the blood.</div>';
    var g4=el.querySelector('.gauge');var up4=function(v){GHVAL=v;ACT.pituitary=v/100;setGauge(g4,v,0,100,[[0,30,'#5aa9e6','under'],[30,70,'#5fce8f','normal'],[70,100,'#e6795a','over']],'%');};
    el.querySelector('#g-s').oninput=function(e){up4(+e.target.value);};up4(50);
    var adhLvl={v:30};
    el.querySelector('#adh-s').oninput=function(e){adhLvl.v=+e.target.value;};
    H2O_PARTICLES=[];H2O_SPAWN_ACC=0;
    DEMO['pituitary']=function(){var fg=document.getElementById('gh-fig');if(fg)drawFigure(fg,GHVAL);var vc=document.getElementById('vaso-cv');if(vc)drawWaterReabsorption(vc,adhLvl.v);};
    applyVasoURL(SUPABASE_IMAGES.vasopressin||'');
    wireVasoUrlField();
  } else if(id==='pineal'){
    el.innerHTML='<div class="labtitle">Try it &mdash; light &amp; melatonin</div><div class="seg2"><button id="day-b" class="on">&#9728; Day</button><button id="night-b">&#127769; Night</button></div>'+gaugeHTML('Melatonin')+'<div class="labhint">Darkness raises melatonin &rarr; you feel sleepy.</div>';
    var g5=el.querySelector('.gauge');var up5=function(v){ACT.pineal=v/100;setGauge(g5,v,0,100,[[0,40,'#e6b04a','low'],[40,100,'#7c6cd6','high']],'%');};
    var db=el.querySelector('#day-b'),nb=el.querySelector('#night-b');
    db.onclick=function(){db.classList.add('on');nb.classList.remove('on');up5(15);};
    nb.onclick=function(){nb.classList.add('on');db.classList.remove('on');up5(85);};up5(15);
  } else if(id==='uterus'){
    el.innerHTML='<div class="labtitle">Try it &mdash; oxytocin &amp; labour</div><div class="seg2"><button id="ut-off" class="on">Contractions OFF</button><button id="ut-on">Contractions ON</button></div><div id="ut-cap" class="labhint">Turn contractions on to watch oxytocin make the uterus squeeze in rhythmic waves.</div>';
    ACT.uterus=0.2;var offb=el.querySelector('#ut-off'),onb=el.querySelector('#ut-on'),cap=el.querySelector('#ut-cap');
    offb.onclick=function(){UTON=false;offb.classList.add('on');onb.classList.remove('on');cap.innerHTML='Contractions off &mdash; oxytocin is low.';};
    onb.onclick=function(){UTON=true;onb.classList.add('on');offb.classList.remove('on');cap.innerHTML='<b>Contracting!</b> Oxytocin makes the uterus muscle squeeze in waves to push the baby out during childbirth. Watch the waves build \u2014 more stretching &rarr; more oxytocin, so contractions get <b>stronger and closer together</b> (positive feedback).';};
  } else if(id==='ovaries'){
    el.innerHTML='<div class="labtitle">At puberty</div><div class="labhint"><b>Estrogen</b> brings the secondary sexual characters:<br><br>Breast development, wider hips, body changes, and the start of the menstrual cycle.</div>'+
      '<div class="labtitle" style="margin-top:18px">Try it \u2014 ovulation</div>'+
      '<canvas class="ovcv" id="ov-cv"></canvas>'+
      '<div class="labhint" id="ovCap" data-stage="0">Once a month, a follicle matures and ruptures to release an egg (ovum) \u2014 called <b>ovulation</b>.</div>'+
      '<button class="labbtn" id="ovPlay">&#9654; Play ovulation</button>'+
      '<div class="labtitle" style="margin-top:18px">Try it \u2014 breast changes in adult life</div>'+
      '<canvas class="devcv" id="dev-cv"></canvas>'+
      '<div class="devnav">'+
        '<button class="devarrow" id="devPrev" title="Previous stage" aria-label="Previous stage"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 L6 10 L12 16"/></svg></button>'+
        '<div id="devCard"></div>'+
        '<button class="devarrow" id="devNext" title="Next stage" aria-label="Next stage"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4 L14 10 L8 16"/></svg></button>'+
      '</div>';
    ACT[id]=0.45; OV.phase='idle';
    BDEV={stage:0,target:0,t0:0,fromStage:0,animating:false};
    updateDevCard(0);
    var dp=document.getElementById('devPrev'), dn=document.getElementById('devNext');
    if(dp) dp.onclick=function(){goDevStage(Math.round(BDEV.target)-1);};
    if(dn) dn.onclick=function(){goDevStage(Math.round(BDEV.target)+1);};
    var pb=document.getElementById('ovPlay'); if(pb) pb.onclick=runOvulation;
  } else {
    var chars='Deep voice, facial &amp; body hair, broader shoulders, muscle growth.';
    el.innerHTML='<div class="labtitle">At puberty</div><div class="labhint"><b>Testosterone</b> brings the secondary sexual characters:<br><br>'+chars+'</div>'+
      '<div class="labtitle" style="margin-top:18px">Try it \u2014 sperm formation</div>'+
      slider('t-sp','Testosterone level',0,100,70)+gaugeHTML('Sperm formation')+
      '<canvas class="ovcv" id="sperm-cv"></canvas>'+
      '<div class="labhint" id="sp-cap"></div>'+
      '<div class="labhint">Testosterone drives the continuous formation of sperm. Cells start round near the outer wall and mature into tailed sperm as they move toward the centre \u2014 millions form every day, unlike the once-a-month release of an egg.</div>'+
      '<div class="labtitle" style="margin-top:18px">Try it \u2014 voice change</div>'+
      '<div class="subimg" id="larynximgwrap"><img id="im-larynx" src="" alt="Larynx" style="display:none;"><div class="subimgph" id="ph-larynx">Paste a larynx diagram URL below to show a real reference image here.</div></div>'+
      '<div class="urlrow" id="urlrow-larynx"><input type="text" id="url-larynx" class="urlin" placeholder="Paste larynx image URL" value="" autocomplete="off" spellcheck="false"><button class="urlreset" id="urlrs-larynx" title="Remove image">Reset</button></div>'+
      pencilRowHTML('larynx',!!(SUPABASE_IMAGES.larynx))+
      slider('t-lvl','Testosterone level',0,100,20)+
      '<canvas class="ovcv" id="pitch-cv" style="height:100px;"></canvas>'+
      '<div class="labhint">Testosterone enlarges the larynx (voice box) and thickens the vocal cords \u2014 the voice drops in pitch and \u201cbreaks\u201d during puberty.</div>';
    ACT[id]=0.45;
    var gsp=el.querySelector('.gauge'),spCap=el.querySelector('#sp-cap');
    var upSp=function(t){SPERM_RATE=spermRateFromT(t);ACT[id]=0.15+0.6*SPERM_RATE;
      setGauge(gsp,SPERM_RATE*100,0,100,[[0,35,'#e6795a','low'],[35,85,'#e6b04a','reduced'],[85,101,'#5fce8f','normal']],'% of normal');
      spCap.innerHTML=t<15?'<b>Very low testosterone</b> \u2014 sperm formation almost stops.':
        t<60?'<b>Below normal testosterone</b> \u2014 fewer cells develop into sperm.':
        '<b>Normal testosterone</b> \u2014 sperm form at the full rate. Raising testosterone further does not increase it; extra testosterone from outside (e.g. steroids) actually <b>lowers</b> sperm count, because it switches off the pituitary hormones (LH and FSH) the testes need.';};
    el.querySelector('#t-sp').oninput=function(e){upSp(+e.target.value);};upSp(70);
    var tlvl={v:20};PST[id]=tlvl;
    el.querySelector('#t-lvl').oninput=function(e){tlvl.v=+e.target.value;};
    DEMO[id]=function(){var pc=document.getElementById('pitch-cv');if(pc)drawPitchWave(pc,tlvl.v);};
    applyLarynxURL(SUPABASE_IMAGES.larynx||'');
    wireLarynxUrlField();
  }
}
var PART={},ACT={},UTON=false,THYSWELL=0,GOI=0,GHVAL=50,ADRHR=72;
var PCOL={thyroid:[255,182,72],pancreas:[77,182,224],adrenal:[255,106,90],pituitary:[143,208,255],parathyroid:[230,210,74],pineal:[154,134,230],ovaries:[229,143,176],testes:[127,200,230],uterus:[228,120,120]};
var CALC_PARTICLES=[],CALC_SPAWN_ACC=0;
function drawOsteocyte(g,r){
  g.beginPath();g.ellipse(0,0,r,r*0.55,0,0,6.2832);g.fill();
  g.strokeStyle=g.fillStyle;g.lineWidth=r*0.18;
  for(var d=0;d<5;d++){
    var da=(d/5)*6.2832+0.4;
    var dl=r*1.6;
    g.beginPath();
    g.moveTo(Math.cos(da)*r*0.5,Math.sin(da)*r*0.3);
    g.lineTo(Math.cos(da)*dl,Math.sin(da)*dl*0.6);
    g.stroke();
  }
}
function drawBoneCalcium(cv,pthVal){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  var imgEl=document.getElementById('im-bone');
  var hasImage=!!(imgEl&&imgEl.style.display==='block');
  if(!hasImage){g.fillStyle='#0f1622';g.fillRect(0,0,w,h);}
  else{g.clearRect(0,0,w,h);}
  var cx=w/2,cy=h*0.46;
  var outerR=Math.min(w,h)*0.42;
  var canalR=outerR*0.15;
  var t=pthVal/100;
  if(!hasImage){
    var nRings=5;
    for(var ri=nRings;ri>=1;ri--){
      var r=canalR+(outerR-canalR)*(ri/nRings);
      var rInner=canalR+(outerR-canalR)*((ri-1)/nRings);
      var lamGrad=g.createRadialGradient(cx,cy,rInner,cx,cy,r);
      if(ri%2===0){lamGrad.addColorStop(0,'#e6dcc9');lamGrad.addColorStop(1,'#dccfb6');}
      else{lamGrad.addColorStop(0,'#d9cdb4');lamGrad.addColorStop(1,'#cdbe9f');}
      g.fillStyle=lamGrad;
      g.beginPath();g.arc(cx,cy,r,0,6.2832);g.fill();
      g.strokeStyle='rgba(120,95,65,.18)';g.lineWidth=1;
      g.beginPath();g.arc(cx,cy,r,0,6.2832);g.stroke();
    }
    g.save();
    g.beginPath();g.arc(cx,cy,outerR,0,6.2832);g.arc(cx,cy,canalR,0,6.2832,true);g.clip();
    for(var fi=0;fi<70;fi++){
      var fa=h1(fi*3.7)*6.2832;
      var fr=canalR+h1(fi*5.1+1)*(outerR-canalR);
      var flen=3+h1(fi*7.3)*5;
      var fx0=cx+Math.cos(fa)*fr,fy0=cy+Math.sin(fa)*fr;
      var perpA=fa+Math.PI/2;
      g.strokeStyle='rgba(255,255,255,'+(0.05+h1(fi*2.2)*0.05)+')';
      g.lineWidth=0.4;
      g.beginPath();
      g.moveTo(fx0-Math.cos(perpA)*flen/2,fy0-Math.sin(perpA)*flen/2);
      g.lineTo(fx0+Math.cos(perpA)*flen/2,fy0+Math.sin(perpA)*flen/2);
      g.stroke();
    }
    g.restore();
  }
  var vkAngle=-0.75;
  if(!hasImage){
    var vkX0=cx+Math.cos(vkAngle)*canalR*0.9,vkY0=cy+Math.sin(vkAngle)*canalR*0.9;
    var vkX1=cx+Math.cos(vkAngle)*outerR*0.98,vkY1=cy+Math.sin(vkAngle)*outerR*0.98;
    var vkWidth=canalR*0.62;
    g.save();
    g.strokeStyle='rgba(180,60,55,.22)';g.lineWidth=vkWidth*2.6;g.lineCap='round';
    g.beginPath();g.moveTo(vkX0,vkY0);g.lineTo(vkX1,vkY1);g.stroke();
    var vkGrad=g.createLinearGradient(vkX0,vkY0,vkX1,vkY1);
    vkGrad.addColorStop(0,'#a8342e');vkGrad.addColorStop(1,'#7a1f1a');
    g.strokeStyle=vkGrad;g.lineWidth=vkWidth;g.lineCap='round';
    g.beginPath();g.moveTo(vkX0,vkY0);g.lineTo(vkX1,vkY1);g.stroke();
    g.strokeStyle='rgba(255,220,210,.3)';g.lineWidth=vkWidth*0.3;g.lineCap='round';
    g.beginPath();g.moveTo(vkX0-vkWidth*0.15,vkY0-vkWidth*0.15);g.lineTo(vkX1-vkWidth*0.15,vkY1-vkWidth*0.15);g.stroke();
    g.restore();
    for(var ri2=1;ri2<=5;ri2++){
      var r2=canalR+(outerR-canalR)*(ri2/5)-(outerR-canalR)/10;
      var count=6+ri2*2;
      for(var k=0;k<count;k++){
        var ang=(k/count)*6.2832+(ri2%2)*0.3;
        var ox=cx+Math.cos(ang)*r2,oy=cy+Math.sin(ang)*r2;
        var innerX=cx+Math.cos(ang)*canalR*1.05,innerY=cy+Math.sin(ang)*canalR*1.05;
        g.strokeStyle='rgba(140,115,90,.30)';g.lineWidth=0.35;
        g.beginPath();g.moveTo(ox,oy);
        g.quadraticCurveTo(cx+Math.cos(ang)*r2*0.55,cy+Math.sin(ang)*r2*0.55,innerX,innerY);
        g.stroke();
        if(k%2===0){
          var ang3=((k+1)/count)*6.2832+(ri2%2)*0.3;
          var ox3=cx+Math.cos(ang3)*r2,oy3=cy+Math.sin(ang3)*r2;
          g.strokeStyle='rgba(140,115,90,.18)';g.lineWidth=0.3;
          g.beginPath();g.moveTo(ox,oy);g.lineTo(ox3,oy3);g.stroke();
        }
        g.save();g.translate(ox,oy);g.rotate(ang);
        g.fillStyle='rgba(75,55,42,.8)';
        drawOsteocyte(g,outerR*0.028);
        g.restore();
      }
    }
    g.strokeStyle='rgba(180,160,130,.4)';g.lineWidth=0.6;
    g.beginPath();g.arc(cx,cy,outerR,0,6.2832);g.stroke();
    var glowGrad=g.createRadialGradient(cx,cy,canalR*0.5,cx,cy,canalR*2.4);
    glowGrad.addColorStop(0,'rgba(200,60,55,.28)');glowGrad.addColorStop(1,'rgba(200,60,55,0)');
    g.fillStyle=glowGrad;
    g.beginPath();g.arc(cx,cy,canalR*2.4,0,6.2832);g.fill();
    g.fillStyle='rgba(230,220,205,.9)';
    g.beginPath();g.arc(cx,cy,canalR*1.18,0,6.2832);g.fill();
    g.strokeStyle='rgba(120,100,80,.35)';g.lineWidth=0.5;g.stroke();
    var arteryX=cx-canalR*0.36,veinX=cx+canalR*0.36;
    var aGrad=g.createRadialGradient(arteryX-canalR*0.25,cy-canalR*0.25,canalR*0.08,arteryX,cy,canalR*0.68);
    aGrad.addColorStop(0,'#ff8a7a');aGrad.addColorStop(0.45,'#e0544a');aGrad.addColorStop(1,'#821b17');
    g.fillStyle=aGrad;
    g.beginPath();g.ellipse(arteryX,cy,canalR*0.6,canalR*0.78,0,0,6.2832);g.fill();
    var vGrad=g.createRadialGradient(veinX-canalR*0.25,cy-canalR*0.25,canalR*0.08,veinX,cy,canalR*0.68);
    vGrad.addColorStop(0,'#b284c2');vGrad.addColorStop(0.45,'#7d4a8f');vGrad.addColorStop(1,'#3e2049');
    g.fillStyle=vGrad;
    g.beginPath();g.ellipse(veinX,cy,canalR*0.6,canalR*0.78,0,0,6.2832);g.fill();
    g.strokeStyle='rgba(60,25,25,.4)';g.lineWidth=0.6;
    g.beginPath();g.ellipse(arteryX,cy,canalR*0.6,canalR*0.78,0,0,6.2832);g.stroke();
    g.beginPath();g.ellipse(veinX,cy,canalR*0.6,canalR*0.78,0,0,6.2832);g.stroke();
  }
  var spawnRate=0.6+t*3.5;
  CALC_SPAWN_ACC+=spawnRate*DT;
  while(CALC_SPAWN_ACC>=1&&CALC_PARTICLES.length<24){
    CALC_SPAWN_ACC-=1;
    var useVk=Math.random()<0.28;
    var ang2,startR;
    if(useVk){ang2=vkAngle+(Math.random()-0.5)*0.3;startR=outerR*(0.45+Math.random()*0.4);}
    else{ang2=Math.random()*6.2832;startR=outerR*(0.55+Math.random()*0.4);}
    CALC_PARTICLES.push({ang:ang2,r:startR,speed:(16+Math.random()*8)*(0.6+t*0.8),toVk:useVk});
  }
  for(var pi=CALC_PARTICLES.length-1;pi>=0;pi--){
    var p=CALC_PARTICLES[pi];
    p.r-=p.speed*DT;
    var targetR=p.toVk?canalR*0.95:canalR;
    if(p.r<=targetR){CALC_PARTICLES.splice(pi,1);continue;}
    var px=cx+Math.cos(p.ang)*p.r,py=cy+Math.sin(p.ang)*p.r;
    var pg=g.createRadialGradient(px-1,py-1,0.2,px,py,2.6);
    pg.addColorStop(0,'#fff2c4');pg.addColorStop(1,'#e8b23a');
    g.fillStyle=pg;
    g.beginPath();g.arc(px,py,hasImage?2.8:2.3,0,6.2832);g.fill();
    if(hasImage){g.strokeStyle='rgba(0,0,0,.35)';g.lineWidth=0.6;g.beginPath();g.arc(px,py,2.8,0,6.2832);g.stroke();}
  }
  if(!hasImage){
    g.fillStyle='rgba(147,163,186,.7)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';
    g.fillText('Haversian system \u2014 Ca\u00b2\u207a diffusing into the vascular canals',cx,cy+outerR+16);
    g.textAlign='left';
  }
}
var H2O_PARTICLES=[],H2O_SPAWN_ACC=0;
function drawWaterReabsorption(cv,adhVal){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  var imgEl=document.getElementById('im-vaso');
  var hasImage=!!(imgEl&&imgEl.style.display==='block');
  if(!hasImage){g.fillStyle='#0f1622';g.fillRect(0,0,w,h);}
  else{g.clearRect(0,0,w,h);}
  var cx=w/2,cy=h*0.46;
  var outerR=Math.min(w,h)*0.42;
  var wallOuterR=outerR*0.78;
  var wallInnerR=outerR*0.50;
  var t=adhVal/100;
  if(!hasImage){
    var capGrad=g.createRadialGradient(cx,cy,wallOuterR,cx,cy,outerR);
    capGrad.addColorStop(0,'#5a2a2e');capGrad.addColorStop(1,'#3a1a1e');
    g.fillStyle=capGrad;
    g.beginPath();g.arc(cx,cy,outerR,0,6.2832);g.fill();
    for(var ci=0;ci<10;ci++){
      var ca=(ci/10)*6.2832+0.3;
      var cr=(wallOuterR+outerR)/2;
      var vx=cx+Math.cos(ca)*cr,vy=cy+Math.sin(ca)*cr;
      g.fillStyle='rgba(200,70,70,.55)';
      g.beginPath();g.ellipse(vx,vy,outerR*0.07,outerR*0.035,ca,0,6.2832);g.fill();
    }
    var wallGrad=g.createRadialGradient(cx,cy,wallInnerR,cx,cy,wallOuterR);
    wallGrad.addColorStop(0,'#c99a5a');wallGrad.addColorStop(1,'#a97a3e');
    g.fillStyle=wallGrad;
    g.beginPath();g.arc(cx,cy,wallOuterR,0,6.2832);g.fill();
    var nPores=14;
    for(var pi=0;pi<nPores;pi++){
      var pa=(pi/nPores)*6.2832;
      var pr=(wallInnerR+wallOuterR)/2;
      var px=cx+Math.cos(pa)*pr,py=cy+Math.sin(pa)*pr;
      var poreSize=(0.35+t*0.65)*outerR*0.045;
      g.fillStyle='rgba(20,15,10,'+(0.3+t*0.5)+')';
      g.beginPath();g.arc(px,py,poreSize,0,6.2832);g.fill();
    }
    var lumGrad=g.createRadialGradient(cx,cy,0,cx,cy,wallInnerR);
    lumGrad.addColorStop(0,'#e8dfa0');lumGrad.addColorStop(1,'#c9bd6e');
    g.fillStyle=lumGrad;
    g.beginPath();g.arc(cx,cy,wallInnerR,0,6.2832);g.fill();
    g.strokeStyle='rgba(180,160,130,.35)';g.lineWidth=0.6;
    g.beginPath();g.arc(cx,cy,outerR,0,6.2832);g.stroke();
  }
  var spawnRate=0.5+t*3.8;
  H2O_SPAWN_ACC+=spawnRate*DT;
  while(H2O_SPAWN_ACC>=1&&H2O_PARTICLES.length<26){
    H2O_SPAWN_ACC-=1;
    var ang=Math.random()*6.2832;
    var startR=wallInnerR*(0.15+Math.random()*0.55);
    H2O_PARTICLES.push({ang:ang,r:startR,speed:(14+Math.random()*7)*(0.55+t*0.85)});
  }
  for(var wi=H2O_PARTICLES.length-1;wi>=0;wi--){
    var p=H2O_PARTICLES[wi];
    p.r+=p.speed*DT;
    if(p.r>=outerR*0.92){H2O_PARTICLES.splice(wi,1);continue;}
    var wx=cx+Math.cos(p.ang)*p.r,wy=cy+Math.sin(p.ang)*p.r;
    var dg=g.createRadialGradient(wx-0.8,wy-0.8,0.2,wx,wy,2.4);
    dg.addColorStop(0,'#cdeeff');dg.addColorStop(1,'#4aa8e0');
    g.fillStyle=dg;
    g.beginPath();g.arc(wx,wy,hasImage?2.6:2.1,0,6.2832);g.fill();
    if(hasImage){g.strokeStyle='rgba(10,40,70,.4)';g.lineWidth=0.5;g.beginPath();g.arc(wx,wy,2.6,0,6.2832);g.stroke();}
  }
  if(!hasImage){
    g.fillStyle='rgba(147,163,186,.7)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';
    g.fillText('collecting duct \u2014 H\u2082O reabsorbed into blood',cx,cy+outerR+16);
    g.textAlign='left';
  }
}
function ensureParticles(id){if(PART[id])return;var arr=[];for(var i=0;i<46;i++)arr.push({a:Math.random()*6.283,r:0.60+Math.random()*0.36,sp:(0.004+Math.random()*0.011)*(Math.random()<0.5?1:-1),sz:1.1+Math.random()*2.3,ph:Math.random()*6.283});PART[id]=arr;}
var SPERM_TRACKS=null;
/* Testosterone slider -> SPERM_RATE (0..1 of the normal rate). Output rises with testosterone and
   levels off once testosterone is in the normal range (more does not raise it further). */
var SPERM_RATE=1;
function spermRateFromT(t){return Math.min(1,Math.pow(Math.max(0,t)/60,1.4));}
/* Background photo of the tubule T.S. Geometry is measured on the 1536x1024 original: centre of the
   lumen and the ellipse just inside the basement membrane where new cells start. */
var TUBULE_PIC=null;
if(typeof TUBULE_IMG==='string'){TUBULE_PIC=new Image();TUBULE_PIC.src=TUBULE_IMG;}
var TUB_GEO={w:1536,h:1024,cx:778,cy:500,rx:515,ry:430,lumen:0.14};
function ensureSpermTracks(){
  if(SPERM_TRACKS)return;
  SPERM_TRACKS=[];
  var N=16,RANK=[0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15]; // rank spreads the active tracks evenly round the tubule
  for(var i=0;i<N;i++){
    SPERM_TRACKS.push({angle:i/N*6.28318+h1(i*3.3)*0.3,phase:h1(i*7.7),speed:0.08+h1(i*5.1)*0.035,rank:RANK[i],idle:false});
  }
}
function smoothstepP(t){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);}
function spermHeadPath(g,len,width){
  g.beginPath();
  g.moveTo(len*0.62,0);
  g.quadraticCurveTo(len*0.30,-width*0.56,-len*0.12,-width*0.50);
  g.quadraticCurveTo(-len*0.52,-width*0.30,-len*0.58,0);
  g.quadraticCurveTo(-len*0.52,width*0.30,-len*0.12,width*0.50);
  g.quadraticCurveTo(len*0.30,width*0.56,len*0.62,0);
  g.closePath();
}
/* Each track: a round cell starts at the outer (basal) wall and matures into a tailed sperm while it is
   carried toward the lumen at the centre. As in the real tubule (and the photo), heads face the wall and
   tails point into the lumen; sperm are released there and fade out. Drawn translucent pinkish-white so
   the tissue photo shows through. */
function drawSpermatogenesis(cv){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  ensureSpermTracks();
  var usePic=TUBULE_PIC&&TUBULE_PIC.complete&&TUBULE_PIC.naturalWidth>0;
  var cx,cy,kx,ky,Router,Rinner,labelY;
  if(usePic){
    var availH=h-20,sc=Math.min(w/TUB_GEO.w,availH/TUB_GEO.h),dw=TUB_GEO.w*sc,dh=TUB_GEO.h*sc,ox=(w-dw)/2,oy=(availH-dh)/2;
    g.drawImage(TUBULE_PIC,ox,oy,dw,dh);
    cx=ox+TUB_GEO.cx*sc;cy=oy+TUB_GEO.cy*sc;Router=TUB_GEO.rx*sc;kx=1;ky=TUB_GEO.ry/TUB_GEO.rx;Rinner=Router*TUB_GEO.lumen;labelY=h-6;
  } else {
    cx=w/2;cy=h*0.48;Router=Math.min(w,h)*0.38;Rinner=Router*0.16;kx=1;ky=1;labelY=cy+Router+16;
    var wallGrad=g.createRadialGradient(cx-Router*0.3,cy-Router*0.3,Router*0.2,cx,cy,Router*1.1);
    wallGrad.addColorStop(0,'#4a3a2e');wallGrad.addColorStop(1,'#2a1e16');
    g.fillStyle=wallGrad;g.beginPath();g.arc(cx,cy,Router,0,6.2832);g.fill();
    g.fillStyle='#160f0a';g.beginPath();g.arc(cx,cy,Rinner,0,6.2832);g.fill();
    g.strokeStyle='rgba(210,180,150,.3)';g.lineWidth=1;
    g.beginPath();g.arc(cx,cy,Router,0,6.2832);g.stroke();
    g.beginPath();g.arc(cx,cy,Rinner,0,6.2832);g.stroke();
  }
  var startSize=Router*0.075;   // round spermatogonium-sized cell at the wall
  var nAct=Math.round(SPERM_RATE*SPERM_TRACKS.length),spd=0.55+0.45*SPERM_RATE;
  for(var i=0;i<SPERM_TRACKS.length;i++){
    var tr=SPERM_TRACKS[i];
    // fewer cells enter development when testosterone is low; ones already developing finish their journey
    if(tr.idle){if(tr.rank<nAct){tr.idle=false;tr.phase=0;}else continue;}
    tr.phase+=tr.speed*spd*DT;
    if(tr.phase>1){if(tr.rank>=nAct){tr.idle=true;continue;}tr.phase-=1;}
    var p=tr.phase;
    var r=Router-(Router-Rinner)*p;
    var x=cx+Math.cos(tr.angle)*r*kx,y=cy+Math.sin(tr.angle)*r*ky;
    var rot=Math.atan2(Math.sin(tr.angle)*ky,Math.cos(tr.angle)*kx);   // radial direction on the ellipse
    var alpha=(p<0.06?p/0.06:1)*(p<0.90?1:(1-(p-0.90)/0.10));
    var s=smoothstepP(p);
    var headLen=startSize+(Router*0.09-startSize)*s;      // round cell -> slim sperm head
    var headW=startSize+(Router*0.05-startSize)*s;
    var midLen=Router*0.045*Math.pow(s,1.6);
    var midW=headW*0.42;
    var tailLen=Router*0.40*Math.pow(s,1.3);
    g.save();g.translate(x,y);g.rotate(rot);
    g.shadowColor='rgba(255,170,215,'+(0.55*alpha)+')';g.shadowBlur=Math.max(2,Router*0.03);
    var hg=g.createRadialGradient(headLen*0.1,-headW*0.2,0.3,0,0,Math.max(headLen,headW)*0.65);
    hg.addColorStop(0,'rgba(255,248,252,'+(0.88*alpha)+')');
    hg.addColorStop(1,'rgba(250,200,228,'+(0.62*alpha)+')');
    spermHeadPath(g,headLen,headW);
    g.fillStyle=hg;g.fill();
    g.shadowBlur=0;
    // thin deep-magenta rim keeps the translucent white sperm visible over the pale lumen
    g.strokeStyle='rgba(125,35,95,'+(0.60*alpha)+')';g.lineWidth=Math.max(0.8,Router*0.006);g.stroke();
    if(midLen>0.15){
      g.fillStyle='rgba(252,214,234,'+(0.60*alpha)+')';
      g.fillRect(-headLen*0.58-midLen,-midW/2,midLen,midW);
    }
    if(tailLen>0.15){
      var tailStart=-headLen*0.58-midLen;
      g.strokeStyle='rgba(255,236,246,'+(0.82*alpha)+')';g.lineWidth=Math.max(1,Router*0.008*s);g.lineCap='round';
      g.shadowColor='rgba(255,170,215,'+(0.6*alpha)+')';g.shadowBlur=Math.max(2,Router*0.02);
      var wob=Math.sin(Date.now()*0.004+i*2)*Router*0.025*s;   // gentle passive sway (sperm are not yet motile here)
      var tailPath=function(){g.beginPath();g.moveTo(tailStart,0);
        g.quadraticCurveTo(tailStart-tailLen*0.40,wob,tailStart-tailLen*0.75,-wob*1.3);
        g.quadraticCurveTo(tailStart-tailLen*0.92,wob*1.6,tailStart-tailLen,-wob*0.7);};
      var lw=g.lineWidth,ls=g.strokeStyle;
      tailPath();g.shadowBlur=0;g.strokeStyle='rgba(125,35,95,'+(0.45*alpha)+')';g.lineWidth=lw+1.4;g.stroke();
      tailPath();g.strokeStyle=ls;g.lineWidth=lw;g.stroke();
    }
    g.restore();
  }
  g.fillStyle='rgba(147,163,186,.6)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';
  g.fillText('seminiferous tubule (cross-section)',cx,labelY);
  g.textAlign='left';
}
function drawPitchWave(cv,tVal){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var t=tVal/100;
  var waveX0=w*0.06,waveX1=w*0.94,waveY=h*0.40,waveAmp=h*0.24;
  var freq=6.5-t*4.2;
  g.strokeStyle='#5cc8d6';g.lineWidth=1.8;g.beginPath();
  for(var px=0;px<=200;px++){
    var frac=px/200;
    var xx=waveX0+(waveX1-waveX0)*frac;
    var yy=waveY+Math.sin(frac*freq*6.2832)*waveAmp;
    if(px===0)g.moveTo(xx,yy);else g.lineTo(xx,yy);
  }
  g.stroke();
  g.fillStyle='rgba(147,163,186,.7)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';
  g.fillText('voice pitch',(waveX0+waveX1)/2,waveY+waveAmp+18);
  var pitchLabel=t<0.3?'High-pitched (childhood)':(t<0.65?'Voice breaking':'Deep voice (adult)');
  g.fillStyle='#e7edf5';g.font='700 12px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';
  g.fillText(pitchLabel,w/2,h*0.90);
  g.textAlign='left';
}
function drawParticles(cv,id){
  ensureParticles(id);var act=ACT[id]==null?0.4:ACT[id];if(act<0)act=0;if(act>1)act=1;
  var rect=cv.getBoundingClientRect();var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));
  if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var cx=w/2,cy=h/2,R=Math.min(w,h)*0.46,col=PCOL[id]||[92,200,214];
  var arr=PART[id],t=Date.now()*0.001;g.globalCompositeOperation='lighter';
  for(var i=0;i<arr.length;i++){var p=arr[i];p.a+=p.sp*(0.3+act*2.0)*DT*60;
    var rr=(p.r+Math.sin(t*1.4+p.ph)*0.03)*R;
    var x=cx+Math.cos(p.a)*rr,y=cy+Math.sin(p.a)*rr*0.92;
    var pulse=0.5+0.5*Math.sin(t*3+p.ph);
    var alpha=(0.10+act*0.6)*(0.45+0.55*pulse);
    var sz=p.sz*(0.6+act*1.2)*(0.8+0.4*pulse);
    var grd=g.createRadialGradient(x,y,0,x,y,sz*3);
    grd.addColorStop(0,'rgba('+col[0]+','+col[1]+','+col[2]+','+alpha+')');
    grd.addColorStop(1,'rgba('+col[0]+','+col[1]+','+col[2]+',0)');
    g.fillStyle=grd;g.beginPath();g.arc(x,y,sz*3,0,6.283);g.fill();
  }
  g.globalCompositeOperation='source-over';
}
var BODY_OUTLINE_D='M 200.0 20.0 C 205.0 21.3 222.2 20.5 230.2 28.0 C 238.3 35.5 245.4 51.7 248.1 65.0 C 250.8 78.3 248.7 96.8 246.2 108.0 C 243.8 119.2 236.9 124.7 233.7 132.0 C 230.4 139.3 226.8 144.3 226.6 152.0 C 226.4 159.7 222.9 171.7 232.2 178.0 C 241.5 184.3 264.5 185.5 282.4 190.0 C 300.2 194.5 325.1 194.2 339.2 205.0 C 353.3 215.8 364.5 235.0 367.1 255.0 C 369.7 275.0 358.7 301.7 354.8 325.0 C 350.8 348.3 347.3 373.8 343.5 395.0 C 339.7 416.2 333.6 436.2 332.1 452.0 C 330.5 467.8 335.8 477.3 334.1 490.0 C 332.3 502.7 329.9 522.7 321.7 528.0 C 313.6 533.3 291.3 530.3 285.2 522.0 C 279.2 513.7 284.2 497.5 285.4 478.0 C 286.5 458.5 290.1 428.8 292.2 405.0 C 294.2 381.2 299.6 357.5 297.8 335.0 C 296.1 312.5 289.3 287.2 281.5 270.0 C 273.7 252.8 251.9 232.8 251.0 232.0 C 250.2 231.2 273.9 250.0 276.4 265.0 C 278.9 280.0 271.8 302.0 266.3 322.0 C 260.8 342.0 245.6 369.5 243.4 385.0 C 241.2 400.5 247.9 406.7 253.2 415.0 C 258.5 423.3 270.5 426.7 275.3 435.0 C 280.1 443.3 283.0 446.7 281.9 465.0 C 280.8 483.3 273.2 518.3 268.8 545.0 C 264.3 571.7 258.4 600.0 255.4 625.0 C 252.4 650.0 253.3 670.0 251.0 695.0 C 248.7 720.0 244.1 753.3 241.4 775.0 C 238.7 796.7 233.2 812.2 234.9 825.0 C 236.7 837.8 247.1 843.7 252.0 852.0 C 256.8 860.3 263.2 868.3 264.0 875.0 C 264.9 881.7 264.5 889.2 256.8 892.0 C 249.1 894.8 225.1 894.8 217.6 892.0 C 210.2 889.2 214.0 881.7 212.1 875.0 C 210.3 868.3 206.9 860.3 206.5 852.0 C 206.1 843.7 208.8 837.8 209.7 825.0 C 210.7 812.2 212.0 796.7 212.0 775.0 C 212.0 753.3 210.7 720.0 209.8 695.0 C 208.9 670.0 207.6 650.0 206.5 625.0 C 205.4 600.0 204.3 570.8 203.2 545.0 C 202.2 519.2 201.1 470.0 200.0 470.0 C 198.9 470.0 197.8 519.2 196.8 545.0 C 195.7 570.8 194.6 600.0 193.5 625.0 C 192.4 650.0 191.1 670.0 190.2 695.0 C 189.3 720.0 188.0 753.3 188.0 775.0 C 188.0 796.7 189.3 812.2 190.3 825.0 C 191.2 837.8 193.9 843.7 193.5 852.0 C 193.1 860.3 189.7 868.3 187.9 875.0 C 186.0 881.7 189.8 889.2 182.4 892.0 C 174.9 894.8 150.9 894.8 143.2 892.0 C 135.5 889.2 135.1 881.7 136.0 875.0 C 136.8 868.3 143.2 860.3 148.0 852.0 C 152.9 843.7 163.3 837.8 165.1 825.0 C 166.8 812.2 161.3 796.7 158.6 775.0 C 155.9 753.3 151.3 720.0 149.0 695.0 C 146.7 670.0 147.6 650.0 144.6 625.0 C 141.6 600.0 135.7 571.7 131.2 545.0 C 126.8 518.3 119.2 483.3 118.1 465.0 C 117.0 446.7 119.9 443.3 124.7 435.0 C 129.5 426.7 141.5 423.3 146.8 415.0 C 152.1 406.7 158.8 400.5 156.6 385.0 C 154.4 369.5 139.2 342.0 133.7 322.0 C 128.2 302.0 121.1 280.0 123.6 265.0 C 126.1 250.0 149.8 231.2 149.0 232.0 C 148.1 232.8 126.3 252.8 118.5 270.0 C 110.7 287.2 103.9 312.5 102.2 335.0 C 100.4 357.5 105.8 381.2 107.8 405.0 C 109.9 428.8 113.5 458.5 114.6 478.0 C 115.8 497.5 120.8 513.7 114.8 522.0 C 108.7 530.3 86.4 533.3 78.3 528.0 C 70.1 522.7 67.7 502.7 65.9 490.0 C 64.2 477.3 69.5 467.8 67.9 452.0 C 66.4 436.2 60.3 416.2 56.5 395.0 C 52.7 373.8 49.2 348.3 45.2 325.0 C 41.3 301.7 30.3 275.0 32.9 255.0 C 35.5 235.0 46.7 215.8 60.8 205.0 C 74.9 194.2 99.8 194.5 117.6 190.0 C 135.5 185.5 158.5 184.3 167.8 178.0 C 177.1 171.7 173.6 159.7 173.4 152.0 C 173.2 144.3 169.6 139.3 166.3 132.0 C 163.1 124.7 156.2 119.2 153.8 108.0 C 151.3 96.8 149.2 78.3 151.9 65.0 C 154.6 51.7 161.7 35.5 169.8 28.0 C 177.8 20.5 195.0 21.3 200.0 20.0 C 205.0 18.7 195.0 18.7 200.0 20.0 Z';
var BODY_OUTLINE_D_FEMALE='M 200.0 20.0 C 205.0 21.3 222.2 20.5 230.2 28.0 C 238.3 35.5 245.4 51.7 248.1 65.0 C 250.8 78.3 248.7 96.8 246.2 108.0 C 243.8 119.2 236.9 124.7 233.7 132.0 C 230.4 139.3 226.8 144.3 226.6 152.0 C 226.4 159.7 225.2 171.7 232.2 178.0 C 239.1 184.3 254.5 185.5 268.4 190.0 C 282.3 194.5 301.9 194.2 315.5 205.0 C 329.2 215.8 346.5 235.0 350.4 255.0 C 354.4 275.0 342.4 301.7 339.3 325.0 C 336.2 348.3 334.5 373.8 332.0 395.0 C 329.5 416.2 324.9 436.2 324.2 452.0 C 323.4 467.8 328.8 477.3 327.4 490.0 C 325.9 502.7 323.4 522.7 315.6 528.0 C 307.9 533.3 286.7 530.3 281.0 522.0 C 275.2 513.7 279.8 497.5 281.1 478.0 C 282.3 458.5 286.3 428.8 288.5 405.0 C 290.6 381.2 296.4 357.5 293.9 335.0 C 291.4 312.5 281.7 287.2 273.3 270.0 C 264.9 252.8 242.6 232.8 243.4 232.0 C 244.2 231.2 273.6 250.0 277.9 265.0 C 282.3 280.0 273.4 302.0 269.6 322.0 C 265.9 342.0 255.8 369.5 255.5 385.0 C 255.3 400.5 262.5 406.7 268.1 415.0 C 273.6 423.3 283.5 426.7 288.8 435.0 C 294.1 443.3 300.8 446.7 299.9 465.0 C 299.1 483.3 290.2 518.3 283.9 545.0 C 277.6 571.7 266.8 600.0 262.0 625.0 C 257.2 650.0 258.2 670.0 255.1 695.0 C 251.9 720.0 246.3 753.3 243.1 775.0 C 239.8 796.7 234.1 812.2 235.6 825.0 C 237.1 837.8 247.2 843.7 252.0 852.0 C 256.7 860.3 263.2 868.3 264.0 875.0 C 264.9 881.7 264.5 889.2 256.8 892.0 C 249.1 894.8 225.1 894.8 217.6 892.0 C 210.2 889.2 214.0 881.7 212.1 875.0 C 210.3 868.3 206.9 860.3 206.5 852.0 C 206.1 843.7 208.8 837.8 209.7 825.0 C 210.7 812.2 212.0 796.7 212.0 775.0 C 212.0 753.3 210.7 720.0 209.8 695.0 C 208.9 670.0 207.6 650.0 206.5 625.0 C 205.4 600.0 204.3 570.8 203.2 545.0 C 202.2 519.2 201.1 470.0 200.0 470.0 C 198.9 470.0 197.8 519.2 196.8 545.0 C 195.7 570.8 194.6 600.0 193.5 625.0 C 192.4 650.0 191.1 670.0 190.2 695.0 C 189.3 720.0 188.0 753.3 188.0 775.0 C 188.0 796.7 189.3 812.2 190.3 825.0 C 191.2 837.8 193.9 843.7 193.5 852.0 C 193.1 860.3 189.7 868.3 187.9 875.0 C 186.0 881.7 189.8 889.2 182.4 892.0 C 174.9 894.8 150.9 894.8 143.2 892.0 C 135.5 889.2 135.1 881.7 136.0 875.0 C 136.8 868.3 143.3 860.3 148.0 852.0 C 152.8 843.7 162.9 837.8 164.4 825.0 C 165.9 812.2 160.2 796.7 156.9 775.0 C 153.7 753.3 148.1 720.0 144.9 695.0 C 141.8 670.0 142.8 650.0 138.0 625.0 C 133.2 600.0 122.4 571.7 116.1 545.0 C 109.8 518.3 100.9 483.3 100.1 465.0 C 99.2 446.7 105.9 443.3 111.2 435.0 C 116.5 426.7 126.4 423.3 131.9 415.0 C 137.5 406.7 144.7 400.5 144.5 385.0 C 144.2 369.5 134.1 342.0 130.4 322.0 C 126.6 302.0 117.7 280.0 122.1 265.0 C 126.4 250.0 155.8 231.2 156.6 232.0 C 157.4 232.8 135.1 252.8 126.7 270.0 C 118.3 287.2 108.6 312.5 106.1 335.0 C 103.6 357.5 109.4 381.2 111.5 405.0 C 113.7 428.8 117.7 458.5 118.9 478.0 C 120.2 497.5 124.8 513.7 119.0 522.0 C 113.3 530.3 92.1 533.3 84.4 528.0 C 76.6 522.7 74.1 502.7 72.6 490.0 C 71.2 477.3 76.6 467.8 75.8 452.0 C 75.1 436.2 70.5 416.2 68.0 395.0 C 65.5 373.8 63.8 348.3 60.7 325.0 C 57.6 301.7 45.6 275.0 49.6 255.0 C 53.5 235.0 70.8 215.8 84.5 205.0 C 98.1 194.2 117.7 194.5 131.6 190.0 C 145.5 185.5 160.9 184.3 167.8 178.0 C 174.8 171.7 173.6 159.7 173.4 152.0 C 173.2 144.3 169.6 139.3 166.3 132.0 C 163.1 124.7 156.2 119.2 153.8 108.0 C 151.3 96.8 149.2 78.3 151.9 65.0 C 154.6 51.7 161.7 35.5 169.8 28.0 C 177.8 20.5 195.0 21.3 200.0 20.0 C 205.0 18.7 195.0 18.7 200.0 20.0 Z';
var BODY_OUTLINE_PATH2D_FEMALE=(typeof Path2D!=='undefined')?new Path2D(BODY_OUTLINE_D_FEMALE):null;
var BODY_OUTLINE_PATH2D=(typeof Path2D!=='undefined')?new Path2D(BODY_OUTLINE_D):null;
var BODY_OUTLINE_H=874, BODY_OUTLINE_CX=199.5, BODY_OUTLINE_FEET_Y=893;
var BODY_OUTLINE_H_F=874, BODY_OUTLINE_CX_F=199.5, BODY_OUTLINE_FEET_Y_F=893;
function drawFigure2D(cv,gh){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),hgt=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==hgt*dpr){cv.width=w*dpr;cv.height=hgt*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,hgt);
  var ground=hgt-24,maxH=hgt*0.58,hf=0.42+gh/100*0.80,figH=maxH*hf,cx=w/2;
  var normalTop=ground-maxH*0.975;
  g.strokeStyle='rgba(147,163,186,.35)';g.setLineDash([5,5]);g.beginPath();g.moveTo(20,normalTop);g.lineTo(w-20,normalTop);g.stroke();g.setLineDash([]);
  g.fillStyle='rgba(147,163,186,.6)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='left';g.fillText('normal height',22,normalTop-5);
  var col=gh<30?'#5aa9e6':(gh>70?'#e6795a':'#5fce8f');
  var colDark=gh<30?'#3a7ab0':(gh>70?'#b04a35':'#2f9a63');
  var isF=(typeof sex!=='undefined' && sex==='female');
  var OD=isF?BODY_OUTLINE_D_FEMALE:BODY_OUTLINE_D;
  var OP=isF?BODY_OUTLINE_PATH2D_FEMALE:BODY_OUTLINE_PATH2D;
  var OH=isF?BODY_OUTLINE_H_F:BODY_OUTLINE_H;
  var OCX=isF?BODY_OUTLINE_CX_F:BODY_OUTLINE_CX;
  var OFY=isF?BODY_OUTLINE_FEET_Y_F:BODY_OUTLINE_FEET_Y;
  var scaleY=figH/OH;
  var widthTrim=gh>50 ? 1-(gh-50)/50*0.14 : 1.0;
  var scaleX=scaleY*widthTrim;
  g.save();
  g.fillStyle='rgba(0,0,0,.28)';
  g.beginPath();g.ellipse(cx,ground+3,figH*0.16,4,0,0,6.2832);g.fill();
  g.translate(cx-OCX*scaleX, ground-OFY*scaleY);
  g.scale(scaleX,scaleY);
  var grad=g.createLinearGradient(OCX-90,0,OCX+90,0);
  grad.addColorStop(0,colDark);grad.addColorStop(0.45,col);grad.addColorStop(0.55,col);grad.addColorStop(1,colDark);
  g.fillStyle=grad;
  try{
    if(OP) g.fill(OP);
    else if(typeof Path2D!=='undefined') g.fill(new Path2D(OD));
  }catch(e){/* Path2D unavailable in this environment — figure silhouette skipped, rest of UI unaffected */}
  g.restore();
  g.strokeStyle='rgba(147,163,186,.5)';g.beginPath();g.moveTo(10,ground);g.lineTo(w-10,ground);g.stroke();
  var lab=gh<30?'Dwarfism (too little GH)':(gh>70?'Gigantism (too much GH)':'Normal growth');
  g.fillStyle=col;g.font='700 12px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';g.fillText(lab,cx,hgt-6);g.textAlign='left';
}
/* ===== Growth-hormone figure: real 3D base meshes (free_pack_male/female_base_mesh.glb) =====
   No skeleton in these models, so the body is reshaped region by region using per-vertex weights
   computed offline (arm, hand, foot, head) and landmarks (crotch, armpit, shoulder joint, neck,
   wrist, ankle). The slider sets:
     GH < 30  -> pituitary dwarfism: short but PROPORTIONATE body (not achondroplasia), childlike
                 head-to-body ratio, small hands and feet, slightly fuller trunk
     30..70   -> normal adult
     GH > 70  -> gigantism (GH excess before growth plates close): very tall, mainly long legs and
                 arms, large hands and feet
   Male or female follows the Biological Sex buttons. Falls back to the flat 2D figure without WebGL. */
var GHF=null;
function ghfSmooth(e0,e1,x){var t=(x-e0)/(e1-e0);t=t<0?0:t>1?1:t;return t*t*(3-2*t);}
function ghfHeight(gh){return gh<30?1-0.36*(30-gh)/30:(gh>70?1+0.34*(gh-70)/30:1);}
function ghfInit(){
  if(GHF!==null)return GHF||null;
  GHF=false;
  try{
    var cv=document.createElement('canvas');
    var gl=cv.getContext('webgl',{antialias:true,alpha:true,premultipliedAlpha:true});
    if(!gl)return null;
    var VS='precision highp float;attribute vec3 aP;attribute vec3 aN;attribute float aC;uniform float uYaw,uS,uG,uCx,uW,uH;varying vec3 vN;varying float vC;'+
      'void main(){float c=cos(uYaw),s=sin(uYaw);vec3 p=vec3(aP.x*c+aP.z*s,aP.y,-aP.x*s+aP.z*c);vN=vec3(aN.x*c+aN.z*s,aN.y,-aN.x*s+aN.z*c);vC=aC;'+
      'float px=uCx+p.x*uS,py=uG-p.y*uS;gl_Position=vec4(px/uW*2.0-1.0,1.0-py/uH*2.0,-p.z*0.5,1.0);}';
    var FS='precision mediump float;varying vec3 vN;varying float vC;'+
      'void main(){vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;vec3 L=normalize(vec3(-0.42,0.5,0.92)),Hh=normalize(L+vec3(0.,0.,1.));'+
      'vec3 col=vC<0.5?vec3(224.,181.,152.)/255.:vec3(70.,52.,44.)/255.;'+
      'float wrap=max(0.,dot(n,L)*0.65+0.35),spec=pow(max(0.,dot(n,Hh)),26.)*0.4,fres=pow(1.-min(1.,abs(n.z)),3.)*0.3;'+
      'vec3 c=col*(0.34+0.66*wrap);c=mix(c,min(vec3(1.),col*vec3(1.25,1.05,1.05)+vec3(.16,.12,.12)),fres);c=mix(c,vec3(1.,.98,.96),spec);gl_FragColor=vec4(c,1.);}';
    function sh(t,src){var s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    GHF={cv:cv,gl:gl,pr:pr,m:{},u:{},aP:gl.getAttribLocation(pr,'aP'),aN:gl.getAttribLocation(pr,'aN'),aC:gl.getAttribLocation(pr,'aC')};
    ['uYaw','uS','uG','uCx','uW','uH'].forEach(function(n){GHF.u[n]=gl.getUniformLocation(pr,n);});
    cv.addEventListener('webglcontextlost',function(e){e.preventDefault();GHF=false;});
    return GHF;
  }catch(e){GHF=false;return null;}
}
function ghfMesh(g,sx){
  if(g.m[sx])return g.m[sx];
  var d=GH_MESH[sx],gl=g.gl,q=new Int16Array(b64ToBuf(d.v)),ix=new Uint16Array(b64ToBuf(d.i)),fc=new Uint8Array(b64ToBuf(d.c)),wq=new Uint8Array(b64ToBuf(d.w));
  var n=d.nv,P=new Float32Array(3*n),C=new Float32Array(n),Wt=new Float32Array(4*n);
  for(var k=0;k<3*n;k++)P[k]=q[k]/30000;for(k=0;k<4*n;k++)Wt[k]=wq[k]/255;
  for(var t=0;t<d.nf;t++)if(fc[t]){C[ix[3*t]]=1;C[ix[3*t+1]]=1;C[ix[3*t+2]]=1;}
  function buf(a,type,usage){var b=gl.createBuffer();gl.bindBuffer(type,b);gl.bufferData(type,a,usage||gl.STATIC_DRAW);return b;}
  var m={L:d.L,P:P,W:Wt,ix:ix,n:n,count:ix.length,out:new Float32Array(3*n),nrm:new Float32Array(3*n),
    bP:buf(new Float32Array(3*n),gl.ARRAY_BUFFER,gl.DYNAMIC_DRAW),bN:buf(new Float32Array(3*n),gl.ARRAY_BUFFER,gl.DYNAMIC_DRAW),bC:buf(C,gl.ARRAY_BUFFER),bI:buf(ix,gl.ELEMENT_ARRAY_BUFFER),gh:null,top:1};
  g.m[sx]=m;return m;
}
/* reshape the normalised mesh (feet y=0, crown y=1) for a GH value */
function ghfDeform(g,m,gh){
  var d=gh<30?(30-gh)/30:0,G=gh>70?(gh-70)/30:0,L=m.L;
  var Ls=1-0.05*d+0.13*G, Hs=1+0.24*d-0.07*G, As=1-0.04*d+0.11*G, Hd=1-0.16*d+0.16*G, Fd=1-0.16*d+0.16*G, Tw=1+0.08*d-0.03*G;
  var cr=L.crotch,nk=L.neck,an=L.ankle,Jx=L.J[0],Jy=L.J[1],wr=L.wrist,fx=L.footx,fz=L.footz;
  var legK=(cr*Ls-an*Fd)/(cr-an);                         // shin/thigh stretch so the crotch lands at cr*Ls
  function Y(y){return y<an?y*Fd:(y<cr?an*Fd+(y-an)*legK:(y<nk?cr*Ls+(y-cr):cr*Ls+(nk-cr)+(y-nk)*Hs));}
  function trunkW(y){return 1+(Tw-1)*ghfSmooth(cr,cr+0.05,y)*(1-ghfSmooth(L.armpit-0.04,L.armpit+0.02,y));}
  var P=m.P,W=m.W,o=m.out,Jyp=Y(Jy),Jxp=Jx*trunkW(Jy);
  for(var i=0;i<m.n;i++){
    var x=P[3*i],y=P[3*i+1],z=P[3*i+2],wa=W[4*i],wh=W[4*i+1],wf=W[4*i+2],wd=W[4*i+3];
    // trunk / legs / head
    var sxz=trunkW(y),bx=x*sxz,by=Y(y),bz=z*sxz;
    if(wd>0){var hx=x*Hs,hz=z*Hs;bx+=(hx-bx)*wd;bz+=(hz-bz)*wd;}
    if(wf>0){var sg=x<0?-1:1,ffx=sg*fx+(x-sg*fx)*Fd,ffz=fz+(z-fz)*Fd;bx+=(ffx-bx)*wf;bz+=(ffz-bz)*wf;}
    if(wa>0){ // arm: rotate-free scaling about the shoulder joint, hands scaled again about the wrist
      var s=x<0?-1:1,ux=x-s*Jx,uy=y-Jy,dist=Math.hypot(ux,uy)||1e-6;
      var ax=s*Jxp+ux*As,ay=Jyp+uy*As,az=z*As;
      if(wh>0){var k=Math.min(1,wr/dist),wx=ux*k,wy=uy*k;
        var hx2=s*Jxp+wx*As+(ux-wx)*As*Hd,hy2=Jyp+wy*As+(uy-wy)*As*Hd,hz2=z*As*(1+(Hd-1)*0.6);
        ax+=(hx2-ax)*wh;ay+=(hy2-ay)*wh;az+=(hz2-az)*wh;}
      bx+=(ax-bx)*wa;by+=(ay-by)*wa;bz+=(az-bz)*wa;}
    o[3*i]=bx;o[3*i+1]=by;o[3*i+2]=bz;
  }
  // smooth vertex normals of the reshaped surface
  var N=m.nrm,ix=m.ix;N.fill(0);
  for(var t=0;t<ix.length;t+=3){var a=3*ix[t],b=3*ix[t+1],c=3*ix[t+2];
    var e1x=o[b]-o[a],e1y=o[b+1]-o[a+1],e1z=o[b+2]-o[a+2],e2x=o[c]-o[a],e2y=o[c+1]-o[a+1],e2z=o[c+2]-o[a+2];
    var nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x;
    N[a]+=nx;N[a+1]+=ny;N[a+2]+=nz;N[b]+=nx;N[b+1]+=ny;N[b+2]+=nz;N[c]+=nx;N[c+1]+=ny;N[c+2]+=nz;}
  for(i=0;i<m.n;i++){var l=Math.hypot(N[3*i],N[3*i+1],N[3*i+2])||1;N[3*i]/=l;N[3*i+1]/=l;N[3*i+2]/=l;}
  var gl=g.gl;gl.bindBuffer(gl.ARRAY_BUFFER,m.bP);gl.bufferSubData(gl.ARRAY_BUFFER,0,o);gl.bindBuffer(gl.ARRAY_BUFFER,m.bN);gl.bufferSubData(gl.ARRAY_BUFFER,0,N);
  m.top=Y(1);m.gh=gh;
}
function drawFigure(cv,gh){
  var g=(typeof GH_MESH!=='undefined')?ghfInit():null;
  if(!g)return drawFigure2D(cv,gh);
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),hgt=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==hgt*dpr){cv.width=w*dpr;cv.height=hgt*dpr;}
  var c2=cv.getContext('2d');c2.setTransform(dpr,0,0,dpr,0,0);c2.clearRect(0,0,w,hgt);
  var ground=hgt-24,normalPx=(ground-10)*0.70,figPx=normalPx*ghfHeight(gh),cx=w/2,normalTop=ground-normalPx;
  var col=gh<30?'#5aa9e6':(gh>70?'#e6795a':'#5fce8f');
  try{
    var sx=(typeof sex!=='undefined'&&sex==='female')?'female':'male',m=ghfMesh(g,sx);
    if(m.gh!==gh)ghfDeform(g,m,gh);
    var gl=g.gl,gc=g.cv,pw=w*dpr,ph=hgt*dpr;if(gc.width!==pw||gc.height!==ph){gc.width=pw;gc.height=ph;}
    gl.viewport(0,0,pw,ph);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.useProgram(g.pr);
    gl.uniform1f(g.u.uYaw,0.55*Math.sin(Date.now()*0.0006));gl.uniform1f(g.u.uS,figPx/m.top);gl.uniform1f(g.u.uG,ground);gl.uniform1f(g.u.uCx,cx);gl.uniform1f(g.u.uW,w);gl.uniform1f(g.u.uH,hgt);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.bP);gl.enableVertexAttribArray(g.aP);gl.vertexAttribPointer(g.aP,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.bN);gl.enableVertexAttribArray(g.aN);gl.vertexAttribPointer(g.aN,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.bC);gl.enableVertexAttribArray(g.aC);gl.vertexAttribPointer(g.aC,1,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.bI);gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_SHORT,0);
    // dashed "normal height" line now sits exactly at the normal figure's crown
    c2.strokeStyle='rgba(147,163,186,.35)';c2.setLineDash([5,5]);c2.beginPath();c2.moveTo(20,normalTop);c2.lineTo(w-20,normalTop);c2.stroke();c2.setLineDash([]);
    c2.fillStyle='rgba(147,163,186,.6)';c2.font='10px "IBM Plex Sans",Roboto,sans-serif';c2.textAlign='left';c2.fillText('normal height',22,normalTop-5);
    c2.fillStyle='rgba(0,0,0,.28)';c2.beginPath();c2.ellipse(cx,ground+3,figPx*0.16,4,0,0,6.2832);c2.fill();
    c2.drawImage(gc,0,0,w,hgt);
  }catch(e){GHF=false;return drawFigure2D(cv,gh);}
  c2.strokeStyle='rgba(147,163,186,.5)';c2.beginPath();c2.moveTo(10,ground);c2.lineTo(w-10,ground);c2.stroke();
  var lab=gh<30?'Dwarfism (too little GH)':(gh>70?'Gigantism (too much GH)':'Normal growth');
  c2.fillStyle=col;c2.font='700 12px "IBM Plex Sans",Roboto,sans-serif';c2.textAlign='center';c2.fillText(lab,cx,hgt-6);c2.textAlign='left';
}
function heartBody(g){
  g.beginPath();
  g.moveTo(0,-6);
  g.bezierCurveTo(2,-8,5,-9,7,-8);
  g.bezierCurveTo(9,-7,10,-4,10,0);
  g.bezierCurveTo(10,5,7,9,3,13);
  g.bezierCurveTo(1,15,-1,15,-3,13);
  g.bezierCurveTo(-8,8,-11,3,-10,-3);
  g.bezierCurveTo(-10,-6,-8,-8,-5,-8);
  g.bezierCurveTo(-3,-8,-1,-7,0,-6);
  g.closePath();
}
function drawVesselBranch(g,x0,y0,ang,len,width,depth,seed,colorFn){
  if(depth<=0||len<1.3)return;
  var jitter=(h1(seed)-0.5)*0.5;
  var a2=ang+jitter;
  var x1=x0+Math.cos(a2)*len,y1=y0+Math.sin(a2)*len;
  var midx=x0+(x1-x0)*0.5+(h1(seed*3.1)-0.5)*len*0.3;
  var midy=y0+(y1-y0)*0.5+(h1(seed*5.7)-0.5)*len*0.3;
  g.lineWidth=Math.max(0.35,width);
  g.strokeStyle=colorFn(depth);
  g.beginPath();g.moveTo(x0,y0);g.quadraticCurveTo(midx,midy,x1,y1);g.stroke();
  var branches=depth>2?2:(h1(seed*2.3)>0.4?2:1);
  for(var i=0;i<branches;i++){
    var spread=0.45+h1(seed*7.1+i)*0.35;
    drawVesselBranch(g,x1,y1,a2+(i===0?spread:-spread),len*0.66,width*0.6,depth-1,seed*1.618+i*11.3+1,colorFn);
  }
}
function drawHeart2D(cv,hr){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),hgt=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==hgt*dpr){cv.width=w*dpr;cv.height=hgt*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,hgt);
  var t=Date.now()*0.001,freq=hr/60,beat=Math.pow(Math.max(0,Math.sin(t*freq*6.283)),6);
  var s=(Math.min(w,hgt)*0.34)*(1+beat*0.20),cx=w/2,cy=hgt*0.44;
  g.save();g.translate(cx,cy);g.scale(s/16,s/16);
  var grad=g.createRadialGradient(-4,-5,1,0,2,15);
  grad.addColorStop(0,'#ff9585');grad.addColorStop(0.32,'#e8544a');grad.addColorStop(0.68,'#a82c26');grad.addColorStop(1,'#6e1818');
  g.shadowColor='rgba(230,74,74,'+(0.3+beat*0.6)+')';g.shadowBlur=16;
  heartBody(g);g.fillStyle=grad;g.fill();g.shadowBlur=0;
  g.save();heartBody(g);g.clip();
  for(var i=0;i<40;i++){
    var mx=-9+h1(i*3.7)*19,my=-7+h1(i*5.3+1)*20;
    var mr=0.6+h1(i*2.1)*1.4;
    g.fillStyle='rgba('+(h1(i*8.1)>0.5?'80,10,10,':'255,200,180,')+(0.05+h1(i*4.4)*0.08)+')';
    g.beginPath();g.arc(mx,my,mr,0,6.2832);g.fill();
  }
  g.restore();
  g.lineCap='round';g.lineJoin='round';
  g.lineWidth=2.8;g.strokeStyle='#e2564a';g.beginPath();g.moveTo(0.5,-8);g.bezierCurveTo(0,-12,3,-15,7,-14);g.stroke();
  g.lineWidth=2.3;g.strokeStyle='#7a3480';g.beginPath();g.moveTo(4,-8);g.bezierCurveTo(4.3,-11,5.5,-13,6.5,-13.5);g.stroke();
  g.lineWidth=1.9;g.strokeStyle='#4a5aa8';g.beginPath();g.moveTo(-4.5,-7.6);g.lineTo(-5.5,-11.5);g.stroke();
  g.lineWidth=1.5;g.strokeStyle='#8b3a8f';g.beginPath();g.moveTo(-6.5,-6.5);g.lineTo(-8,-9.3);g.stroke();
  g.lineWidth=1.4;g.strokeStyle='#6a3a8f';g.beginPath();g.moveTo(6.5,-6.8);g.lineTo(8.3,-8.8);g.stroke();
  g.save();heartBody(g);g.clip();
  drawVesselBranch(g,-0.5,-4,1.55,8,1.5,5,12.9,function(d){return d>3?'rgba(200,40,40,0.55)':'rgba(160,20,20,0.4)';});
  drawVesselBranch(g,2,-3,1.35,7.5,1.3,5,47.3,function(d){return d>3?'rgba(190,40,50,0.5)':'rgba(150,20,30,0.38)';});
  drawVesselBranch(g,-3,-5,2.0,5.5,1.0,4,91.7,function(d){return 'rgba(70,60,150,0.32)';});
  g.restore();
  g.save();heartBody(g);g.clip();
  var hl=g.createRadialGradient(-4,-6,0,-4,-6,7);
  hl.addColorStop(0,'rgba(255,255,255,.4)');hl.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=hl;g.beginPath();g.ellipse(-4,-6,7,5,-0.3,0,6.2832);g.fill();
  g.restore();
  g.restore();
  g.fillStyle='#93a3ba';g.font='11px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';g.fillText(Math.round(hr)+' bpm',cx,hgt-8);g.textAlign='left';
}
/* ===== 3D beating heart (adrenal lab) =====
   Mesh + textures come from realistic_human_heart.glb (embedded as HEART_MESH). Drawn with WebGL
   (colour map + normal map, wet-tissue highlight). The beat follows the cardiac cycle instead of a
   simple pulse:  atrial systole (atria squeeze) -> short AV delay -> ventricular systole (ventricles
   squeeze inward, the base/AV plane pulls down toward the apex, and the ventricles twist slightly)
   -> diastole (relaxation and filling). At high heart rates diastole shortens most, as in a real heart.
   Falls back to the original 2D drawing if WebGL or the textures are unavailable. */
var HGL=null,HEART_PHASE=0,HEART_LAST=0;
function heartGLInit(){
  if(HGL!==null)return HGL||null;
  HGL=false;
  try{
    var cv=document.createElement('canvas');
    var gl=cv.getContext('webgl',{antialias:true,alpha:true,premultipliedAlpha:true});
    if(!gl||!gl.getExtension('OES_standard_derivatives'))return null;
    var VS='precision highp float;attribute vec3 aP;attribute vec3 aN;attribute vec2 aUV;'+
      'uniform float uCa,uCv,uYaw,uRoll,uAsp,uS;varying vec3 vN;varying vec3 vV;varying vec2 vUV;'+
      'const vec3 APEX=vec3(0.181,-1.0,0.014);const vec3 BASE=vec3(-0.063,0.051,-0.024);const vec3 ATR=vec3(0.003,0.282,-0.067);const vec3 VES=vec3(0.041,0.698,-0.088);'+
      'vec3 rotAx(vec3 v,vec3 k,float a){float c=cos(a),s=sin(a);return v*c+cross(k,v)*s+k*dot(k,v)*(1.0-c);}'+
      'void main(){vec3 p=aP,n=aN;'+
      ' vec3 ax=normalize(BASE-APEX);float L=length(BASE-APEX);float t=dot(p-APEX,ax);vec3 q=APEX+ax*t;vec3 r=p-q;'+
      ' float wv=1.0-smoothstep(-0.12,0.16,p.y);'+                      /* ventricles */
      ' float wa=smoothstep(-0.02,0.16,p.y)*(1.0-smoothstep(0.38,0.58,p.y));'+ /* atria + auricles */
      ' float wg=smoothstep(0.45,0.75,p.y);'+                               /* great vessels */
      ' float tw=0.11*uCv*wv*clamp(1.0-t/L,0.0,1.0);'+                        /* ventricular twist, largest at apex */
      ' r=rotAx(r,ax,tw);n=rotAx(n,ax,tw);'+
      ' r*=1.0-0.085*uCv*wv;'+                                               /* ventricular wall moves inward */
      ' float dl=0.075*uCv*L;'+                                              /* AV plane descends toward apex */
      ' float tt=t<L?t*(1.0-0.075*uCv):t-dl*(1.0-wg*0.85);'+
      ' p=APEX+ax*tt+r;'+
      ' p=ATR+(p-ATR)*(1.0-0.07*uCa*wa);'+                                    /* atrial contraction */
      ' p=VES+(p-VES)*(1.0+0.025*uCv*wg);'+                                   /* aorta / pulmonary trunk distend on ejection */
      ' float cr=cos(uRoll),sr=sin(uRoll);p=vec3(p.x*cr-p.y*sr,p.x*sr+p.y*cr,p.z);n=vec3(n.x*cr-n.y*sr,n.x*sr+n.y*cr,n.z);'+
      ' float cy=cos(uYaw),sy=sin(uYaw);p=vec3(p.x*cy+p.z*sy,p.y,-p.x*sy+p.z*cy);n=vec3(n.x*cy+n.z*sy,n.y,-n.x*sy+n.z*cy);'+
      ' vN=n;vV=p;vUV=aUV;gl_Position=vec4(p.x*uS/uAsp,p.y*uS,-p.z*0.4,1.0);}';
    var FS='#extension GL_OES_standard_derivatives : enable\nprecision highp float;varying vec3 vN;varying vec3 vV;varying vec2 vUV;uniform sampler2D uTex,uNrm;uniform float uFlash;'+
      'void main(){vec3 N=normalize(vN);if(!gl_FrontFacing)N=-N;'+
      ' vec3 q0=dFdx(vV),q1=dFdy(vV);vec2 st0=dFdx(vUV),st1=dFdy(vUV);vec3 q1p=cross(q1,N),q0p=cross(N,q0);'+
      ' vec3 T=q1p*st0.x+q0p*st1.x,B=q1p*st0.y+q0p*st1.y;float det=max(dot(T,T),dot(B,B));float sc=det==0.0?0.0:inversesqrt(det);'+
      ' vec3 m=texture2D(uNrm,vUV).xyz*2.0-1.0;m.y=-m.y;N=normalize(T*(m.x*sc)+B*(m.y*sc)+N*m.z);'+
      ' vec3 base=texture2D(uTex,vUV).rgb;base=pow(base,vec3(2.2));'+
      ' vec3 V=vec3(0.0,0.0,1.0);vec3 L1=normalize(vec3(-0.45,0.55,0.75)),L2=normalize(vec3(0.7,-0.2,0.45));'+
      ' float d1=max(dot(N,L1),0.0),d2=max(dot(N,L2),0.0);'+
      ' float s1=pow(max(dot(N,normalize(L1+V)),0.0),48.0),s2=pow(max(dot(N,normalize(L2+V)),0.0),32.0);'+
      ' float fr=pow(1.0-max(dot(N,V),0.0),3.0);'+
      ' vec3 c=base*(0.16+1.05*d1+0.35*d2)+vec3(1.0,0.93,0.9)*(0.42*s1+0.12*s2)+vec3(0.55,0.12,0.12)*fr*0.55;'+
      ' c*=1.0+uFlash*0.10;gl_FragColor=vec4(pow(c,vec3(1.0/2.2)),1.0);}';
    function sh(t,src){var s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    var d=HEART_MESH;
    var q=new Int16Array(b64ToBuf(d.v)),nq=new Int8Array(b64ToBuf(d.n)),uq=new Uint16Array(b64ToBuf(d.uv)),ix=new Uint16Array(b64ToBuf(d.i));
    var P=new Float32Array(q.length),N=new Float32Array(nq.length),U=new Float32Array(uq.length);
    for(var k=0;k<q.length;k++){P[k]=q[k]/32000;N[k]=nq[k]/127;}for(k=0;k<uq.length;k++)U[k]=(k&1)?1-uq[k]/65535:uq[k]/65535; /* stored V is bottom-up; glTF/WebGL (no flip) wants top-down */
    function buf(a,type){var b=gl.createBuffer();gl.bindBuffer(type,b);gl.bufferData(type,a,gl.STATIC_DRAW);return b;}
    var H={cv:cv,gl:gl,pr:pr,ready:0,count:ix.length,
      bP:buf(P,gl.ARRAY_BUFFER),bN:buf(N,gl.ARRAY_BUFFER),bU:buf(U,gl.ARRAY_BUFFER),bI:buf(ix,gl.ELEMENT_ARRAY_BUFFER),
      aP:gl.getAttribLocation(pr,'aP'),aN:gl.getAttribLocation(pr,'aN'),aUV:gl.getAttribLocation(pr,'aUV'),u:{}};
    ['uCa','uCv','uYaw','uRoll','uAsp','uS','uTex','uNrm','uFlash'].forEach(function(nm){H.u[nm]=gl.getUniformLocation(pr,nm);});
    function tex(src,unit){var t=gl.createTexture(),im=new Image();im.onload=function(){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,im);gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);H.ready++;};im.src=src;return t;}
    H.tTex=tex(d.tex,0);H.tNrm=tex(d.nrm,1);
    cv.addEventListener('webglcontextlost',function(e){e.preventDefault();HGL=false;});
    HGL=H;return H;
  }catch(e){HGL=false;return null;}
}
/* cardiac cycle -> atrial (ca) and ventricular (cv) contraction, 0..1 */
function heartCycle(hr){
  var now=performance.now()/1000,dt=HEART_LAST?Math.min(0.1,now-HEART_LAST):0;HEART_LAST=now;
  var T=60/Math.max(30,hr);HEART_PHASE=(HEART_PHASE+dt/T)%1;
  var tau=HEART_PHASE*T,k=Math.min(1.15,Math.max(0.55,T/0.833)),ks=Math.sqrt(k);
  var Ta=0.11*k,PR=0.15*k,Ts=0.31*ks;                // atrial systole, AV delay, ventricular systole (s)
  var ca=tau<Ta?Math.pow(Math.sin(Math.PI*tau/Ta),2):0;
  var u=(tau-PR)/Ts,cv=(u>0&&u<1)?Math.pow(Math.sin(Math.PI*Math.pow(u,0.7)),1.4):0;
  return {ca:ca,cv:cv};
}
function drawHeart(cv,hr){
  var H=heartGLInit();
  if(!H||H.ready<2)return drawHeart2D(cv,hr);
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),hgt=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==hgt*dpr){cv.width=w*dpr;cv.height=hgt*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,hgt);
  var c=heartCycle(hr),t=performance.now()/1000;
  try{
    var gl=H.gl,gc=H.cv,pw=w*dpr,ph=(hgt-20)*dpr;if(gc.width!==pw||gc.height!==ph){gc.width=pw;gc.height=ph;}
    gl.viewport(0,0,pw,ph);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.useProgram(H.pr);
    gl.uniform1f(H.u.uCa,c.ca);gl.uniform1f(H.u.uCv,c.cv);gl.uniform1f(H.u.uFlash,c.cv*Math.min(1,(hr-60)/90));
    gl.uniform1f(H.u.uYaw,0.42*Math.sin(t*0.45));gl.uniform1f(H.u.uRoll,0.0);
    gl.uniform1f(H.u.uAsp,pw/ph);gl.uniform1f(H.u.uS,0.9);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,H.tTex);gl.uniform1i(H.u.uTex,0);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,H.tNrm);gl.uniform1i(H.u.uNrm,1);
    gl.bindBuffer(gl.ARRAY_BUFFER,H.bP);gl.enableVertexAttribArray(H.aP);gl.vertexAttribPointer(H.aP,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,H.bN);gl.enableVertexAttribArray(H.aN);gl.vertexAttribPointer(H.aN,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,H.bU);gl.enableVertexAttribArray(H.aUV);gl.vertexAttribPointer(H.aUV,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,H.bI);gl.drawElements(gl.TRIANGLES,H.count,gl.UNSIGNED_SHORT,0);
    // soft red glow that swells with each ventricular beat (stronger when adrenaline is high)
    var gx=w/2,gy=(hgt-20)/2,gr=Math.min(w,hgt)*0.55,ga=0.10+0.22*c.cv*(0.5+Math.min(1,(hr-60)/90));
    var gg=g.createRadialGradient(gx,gy,gr*0.15,gx,gy,gr);gg.addColorStop(0,'rgba(230,74,74,'+ga+')');gg.addColorStop(1,'rgba(230,74,74,0)');
    g.fillStyle=gg;g.fillRect(0,0,w,hgt);
    g.drawImage(gc,0,0,w,hgt-20);
  }catch(e){HGL=false;return drawHeart2D(cv,hr);}
  g.fillStyle='#93a3ba';g.font='11px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';g.fillText(Math.round(hr)+' bpm',w/2,hgt-6);g.textAlign='left';
}
var UT_PHASE=0, UT_START=0;
function uterusSqueeze(){
  if(!UTON){UT_PHASE=0;UT_START=0;return 0;}
  if(UT_START===0)UT_START=Date.now();
  var elapsed=(Date.now()-UT_START)/1000;
  var progress=Math.min(1, elapsed/45); // labour progresses over the demo, like real active labour building up
  var freq=0.30+progress*0.55; // contractions become more frequent
  UT_PHASE+=freq*DT*6.28318;
  var cyclePos=(UT_PHASE%6.28318)/6.28318;
  var shape;
  if(cyclePos<0.22){shape=Math.pow(Math.sin(cyclePos/0.22*1.5708),2);} // fast rise
  else if(cyclePos<0.32){shape=1;} // brief peak
  else{var fp=(cyclePos-0.32)/0.68;shape=Math.pow(Math.max(0,1-fp),1.7);} // slower release
  var intensity=0.55+progress*0.45; // contractions become stronger
  return shape*intensity;
}
function advanceGoi(){GOI+=(THYSWELL-GOI)*(1-Math.exp(-1.83*DT));}
function heartBeatPhase(hr){var t=Date.now()*0.001,freq=hr/60;return Math.pow(Math.max(0,Math.sin(t*freq*6.283)),6);}
function animateImage(id){
  var img=document.getElementById('im-'+id);
  if(!img||img.style.display==='none'||!SUPABASE_IMAGES[id])return;
  var tf='',fl='';
  if(id==='uterus'){var sq=uterusSqueeze();tf='scale('+(1-0.10*sq)+','+(1+0.05*sq)+')';fl='saturate('+(1+sq*0.25)+')';}
  else if(id==='thyroid'){var gs=GOI;tf='scale('+(1+gs*0.30)+')';}
  else if(id==='adrenal'){var b=heartBeatPhase(ADRHR);tf='scale('+(1+b*0.055)+')';fl='drop-shadow(0 0 '+(6+b*16)+'px rgba(230,74,74,'+(0.25+b*0.5)+'))';}
  else if(id==='pancreas'){var a=ACT.pancreas==null?0.3:ACT.pancreas;var t=Date.now()*0.001;var p=0.5+0.5*Math.sin(t*2.2);tf='scale('+(1+p*0.02*(0.4+a))+')';fl='brightness('+(1+a*0.08)+')';}
  else if(id==='pituitary'){var gh=(GHVAL-50)/50;tf='scale('+(1+gh*0.10)+')';}
  else if(id==='parathyroid'){var pa=ACT.parathyroid==null?0.3:ACT.parathyroid;var t2=Date.now()*0.001;var p2=0.5+0.5*Math.sin(t2*1.6);tf='scale('+(1+p2*0.02*(0.4+pa))+')';}
  else if(id==='pineal'){var pn=ACT.pineal==null?0.15:ACT.pineal;fl='brightness('+(0.85+pn*0.35)+')';}
  else {var g=ACT[id]==null?0.3:ACT[id];var t3=Date.now()*0.001;var p3=0.5+0.5*Math.sin(t3*1.4);tf='scale('+(1+p3*0.015*(0.4+g))+')';}
  img.style.transformOrigin='center';img.style.transform=tf;if(fl)img.style.filter=fl;
}
var OV={phase:'idle',t0:0};
var BDEV={stage:0,target:0,t0:0,fromStage:0,animating:false};
/* Breast development (adult stages, shown on the 3D body). The number of lobes (~15-20) is set early; what changes
   is how far the ducts branch and how many LOBULES (milk-forming clusters) there are.
   cluster = lobules per duct, lobeScale = lobule size, estro / prl = hormone bars. */
var DEV_STAGES=[
 {name:'Mature Adult',age:'',cluster:1.45,lobeScale:1.0,estro:85,prl:14,note:'At puberty, rising <b>estrogen</b> made the ducts grow and branch and the first lobules form. In the adult the ducts are fully branched with lobules at their ends; estrogen and progesterone cause small monthly changes.'},
 {name:'Pregnancy & lactation',age:'',cluster:2.6,lobeScale:1.25,estro:100,prl:96,note:'<b>Progesterone</b> and <b>prolactin</b> make the lobules multiply and fill with milk-producing alveoli, and the breast enlarges. <b>Oxytocin</b> from the pituitary then ejects the milk.'},
 {name:'Postmenopausal',age:'~55 yrs',cluster:0.7,lobeScale:0.55,estro:18,prl:8,note:'Estrogen production falls after menopause — lobules shrink, glandular tissue is replaced by fat and the breast becomes smaller and softer.'}
];
var DEV_LAST=DEV_STAGES.length-1;
function devLerp(s){
  s=Math.max(0,Math.min(DEV_LAST,s));
  var i=Math.min(DEV_LAST-1,Math.floor(s)), f=s-i;
  var a=DEV_STAGES[i], b=DEV_STAGES[i+1],L=function(k){return a[k]+(b[k]-a[k])*f;};
  return {cluster:L('cluster'),lobeScale:L('lobeScale'),estro:L('estro'),prl:L('prl')};
}
function updateDevCard(idx){
  var card=document.getElementById('devCard');if(!card)return;
  var S=DEV_STAGES[idx];
  card.classList.remove('devfade');void card.offsetWidth;
  card.innerHTML='<div class="devstage-name">'+S.name+(S.age?' <span class="devage">('+S.age+')</span>':'')+'</div><div class="devnote">'+S.note+'</div>';
  card.classList.add('devfade');
  var dp=document.getElementById('devPrev'), dn=document.getElementById('devNext');
  if(dp) dp.disabled=(idx===0);
  if(dn) dn.disabled=(idx===DEV_LAST);
}
function goDevStage(idx){
  idx=Math.max(0,Math.min(DEV_LAST,idx));
  if(idx===BDEV.target && !BDEV.animating) return;
  BDEV.fromStage=BDEV.stage;BDEV.target=idx;BDEV.t0=Date.now();BDEV.animating=true;
  updateDevCard(idx);
}
/* ===== 3D breast close-up with mammary glands (Ovary tab -> breast development) =====
   Adult reference body (woman_body.glb). Breast outline, centre, nipple and the chest wall underneath
   were MEASURED offline from the mesh (depth map minus chest-wall estimate), so nothing is guessed.
   Every duct point and lobule is clamped to stay inside: below the actual (re-shaped) skin and in front of
   the chest wall. The body represents an ADULT only:
     Mature adult (base) -> Pregnancy & lactation (breast enlarges, lobules multiply)
     -> Postmenopausal (smaller, softer, lobules regress). Puberty is described in the stage note. */
var BR3=null;
function br3Init(){
  if(BR3!==null)return BR3||null;
  BR3=false;
  var g=ghfInit();if(!g||typeof REF_BODY==='undefined'||!REF_BODY.br)return null;
  try{
    var gl=g.gl;
    var VS='precision highp float;attribute vec3 aP;attribute vec3 aN;attribute float aW;attribute float aA;uniform float uYaw,uS,uOx,uOy,uW,uH,uPt;'+
      'varying vec3 vN;varying float vW,vA;void main(){float c=cos(uYaw),s=sin(uYaw);vec3 p=vec3(aP.x*c+aP.z*s,aP.y,-aP.x*s+aP.z*c);'+
      'vN=vec3(aN.x*c+aN.z*s,aN.y,-aN.x*s+aN.z*c);vW=aW;vA=aA;float px=uOx+p.x*uS,py=uOy-p.y*uS;'+
      'gl_Position=vec4(px/uW*2.0-1.0,1.0-py/uH*2.0,-p.z*2.0,1.0);gl_PointSize=max(1.5,aW*uS*uPt);}';
    var FS='precision mediump float;varying vec3 vN;varying float vW,vA;uniform float uMode,uSee;uniform vec3 uCol;'+
      'void main(){vec3 L=normalize(vec3(-0.42,0.5,0.92)),H=normalize(L+vec3(0.,0.,1.));'+
      'if(uMode>1.5){vec2 q=gl_PointCoord*2.0-1.0;float r=dot(q,q);if(r>1.0)discard;float z=sqrt(1.0-r);vec3 n=vec3(q.x,-q.y,z);'+
      ' float d=max(0.,dot(n,L));vec3 c=uCol*(0.45+0.65*d)+vec3(1.)*pow(max(0.,dot(n,H)),20.)*0.35;gl_FragColor=vec4(c*0.9,0.9);return;}'+
      'vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;'+
      'if(uMode>0.5){gl_FragColor=vec4(uCol*0.8,0.8);return;}'+
      'vec3 col=vA>1.5?vec3(60.,45.,40.)/255.:mix(vec3(224.,181.,152.)/255.,vec3(176.,112.,100.)/255.,vA);'+
      'float wrap=max(0.,dot(n,L)*0.65+0.35),sp=pow(max(0.,dot(n,H)),26.)*0.35,fr=pow(1.-min(1.,abs(n.z)),3.)*0.3;'+
      'vec3 c=col*(0.34+0.66*wrap);c=mix(c,min(vec3(1.),col*1.2+0.12),fr);c=mix(c,vec3(1.),sp);'+
      'c=mix(c,vec3(0.96,0.88,0.74)*(0.55+0.5*wrap),0.50*vW*uSee);gl_FragColor=vec4(c,1.);}';
    function sh(t,src){var s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    var d=REF_BODY,q=new Int16Array(b64ToBuf(d.v)),nq=new Int8Array(b64ToBuf(d.n)),ix=new Uint16Array(b64ToBuf(d.i)),fc=new Uint8Array(b64ToBuf(d.c)),wq=new Uint8Array(b64ToBuf(d.w)),n=d.nv;
    var P=new Float32Array(3*n),prof=new Float32Array(n),see=new Float32Array(n),A=new Float32Array(n);
    for(var k=0;k<3*n;k++)P[k]=q[k]/30000;
    for(k=0;k<n;k++){prof[k]=wq[3*k]/255;see[k]=wq[3*k+1]/255;A[k]=wq[3*k+2]/255;}
    for(var t=0;t<d.nf;t++)if(fc[t]){A[ix[3*t]]=2;A[ix[3*t+1]]=2;A[ix[3*t+2]]=2;}          // eyes
    var bq=new Int16Array(b64ToBuf(d.bv)),bix=new Uint16Array(b64ToBuf(d.bi)),BP=new Float32Array(bq.length);for(k=0;k<bq.length;k++)BP[k]=bq[k]/30000;
    var surf=[];for(k=0;k<n;k++)if(prof[k]>0.02||see[k]>0.02)surf.push(k);                  // breast-surface vertices (for skin-depth lookup)
    function buf(a,type,u){var b=gl.createBuffer();gl.bindBuffer(type,b);gl.bufferData(type,a,u||gl.STATIC_DRAW);return b;}
    BR3={g:g,gl:gl,pr:pr,P:P,prof:prof,ix:ix,n:n,out:new Float32Array(3*n),N:new Float32Array(3*n),key:null,glKey:null,G:null,br:d.br,surf:surf,BP:BP,
      bP:buf(new Float32Array(3*n),gl.ARRAY_BUFFER,gl.DYNAMIC_DRAW),bN:buf(new Float32Array(3*n),gl.ARRAY_BUFFER,gl.DYNAMIC_DRAW),bW:buf(see,gl.ARRAY_BUFFER),bA:buf(A,gl.ARRAY_BUFFER),bI:buf(ix,gl.ELEMENT_ARRAY_BUFFER),
      kP:buf(BP,gl.ARRAY_BUFFER),kI:buf(bix,gl.ELEMENT_ARRAY_BUFFER),kCount:bix.length,
      gP:gl.createBuffer(),gS:gl.createBuffer(),u:{},a:{}};
    ['aP','aN','aW','aA'].forEach(function(nm){BR3.a[nm]=gl.getAttribLocation(pr,nm);});
    ['uYaw','uS','uOx','uOy','uW','uH','uPt','uMode','uSee','uCol'].forEach(function(nm){BR3.u[nm]=gl.getUniformLocation(pr,nm);});
    return BR3;
  }catch(e){BR3=false;return null;}
}
function br3Shape(st){   // st: 0 adult, 1 pregnancy & lactation, 2 postmenopausal
  st=Math.max(0,Math.min(2,st));
  var a=Math.min(1,st),b=Math.max(0,st-1);
  return {grow:0.012*a*(1-b)-0.005*b, spread:1+0.10*a*(1-b)-0.04*b, droop:-0.006*b};
}
function br3Side(B,x){return x<0?B.br.R:B.br.L;}
function br3Morph(B,sh){
  var key=sh.grow.toFixed(4)+'|'+sh.spread.toFixed(3)+'|'+sh.droop.toFixed(4);if(B.key===key)return;B.key=key;
  var P=B.P,o=B.out,pf=B.prof;
  for(var i=0;i<B.n;i++){var x=P[3*i],y=P[3*i+1],z=P[3*i+2],w=pf[i];
    if(w>0){var s=br3Side(B,x);x=s.cx+(x-s.cx)*(1+(sh.spread-1)*w);y=s.cy+(y-s.cy)*(1+(sh.spread-1)*w)+sh.droop*w;z+=sh.grow*w;}
    o[3*i]=x;o[3*i+1]=y;o[3*i+2]=z;}
  var N=B.N,ix=B.ix;N.fill(0);
  for(var t=0;t<ix.length;t+=3){var a=3*ix[t],b=3*ix[t+1],c=3*ix[t+2];
    var e1x=o[b]-o[a],e1y=o[b+1]-o[a+1],e1z=o[b+2]-o[a+2],e2x=o[c]-o[a],e2y=o[c+1]-o[a+1],e2z=o[c+2]-o[a+2];
    var nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x;N[a]+=nx;N[a+1]+=ny;N[a+2]+=nz;N[b]+=nx;N[b+1]+=ny;N[b+2]+=nz;N[c]+=nx;N[c+1]+=ny;N[c+2]+=nz;}
  for(i=0;i<B.n;i++){var l=Math.hypot(N[3*i],N[3*i+1],N[3*i+2])||1;N[3*i]/=l;N[3*i+1]/=l;N[3*i+2]/=l;}
  var gl=B.gl;gl.bindBuffer(gl.ARRAY_BUFFER,B.bP);gl.bufferSubData(gl.ARRAY_BUFFER,0,o);gl.bindBuffer(gl.ARRAY_BUFFER,B.bN);gl.bufferSubData(gl.ARRAY_BUFFER,0,N);
}
/* skin depth (re-shaped) and chest-wall depth under a point: inverse-distance average of the 4 nearest vertices in x-y */
function br3Depth(arr,idx,x,y,stride){
  var best=[1e9,1e9,1e9,1e9],bz=[0,0,0,0];
  for(var k=0;k<idx.length;k++){var j=idx[k]*stride,dx=arr[j]-x,dy=arr[j+1]-y,d=dx*dx+dy*dy;
    if(d<best[3]){var p=3;while(p>0&&d<best[p-1]){best[p]=best[p-1];bz[p]=bz[p-1];p--;}best[p]=d;bz[p]=arr[j+2];}}
  if(best[0]>0.0001)return null;                                    // farther than 1 cm-equivalent from the breast surface
  var sw=0,sz=0;for(var m=0;m<4;m++){var w=1/(Math.sqrt(best[m])+1e-4);sw+=w;sz+=w*bz[m];}return sz/sw;
}
function br3Glands(B,sh,S){
  var key=B.key+'|'+S.cluster.toFixed(2)+'|'+S.lobeScale.toFixed(2);if(B.glKey===key)return B.G;
  var lines=[],pts=[],sizes=[],seed=11,rnd=function(){seed=(seed*9301+49297)%233280;return seed/233280;};
  if(!B.bIdx){B.bIdx=[];for(var k=0;k<B.BP.length/3;k++)B.bIdx.push(k);}
  var nDuct=12,nLob=Math.max(1,S.cluster),ls=S.lobeScale;
  function inside(p,r){                                                   // clamp a point between chest wall and skin
    var zs=br3Depth(B.out,B.surf,p[0],p[1],3),zw=br3Depth(B.BP,B.bIdx,p[0],p[1],3);
    if(zs===null)return null;if(zw===null)zw=zs-0.02;
    var lo=zw+0.0012+r,hi=zs-0.0015-r;if(hi<=lo)return null;
    return [p[0],p[1],Math.max(lo,Math.min(hi,p[2]))];
  }
  ['L','R'].forEach(function(sd){
    var s=B.br[sd],cx=s.cx,cy=s.cy+sh.droop*0.8,ap=s.apex,nip=inside([ap[0],ap[1]+sh.droop,ap[2]+sh.grow-0.002],0);
    if(!nip)return;
    for(var i=0;i<nDuct;i++){
      var th=i/nDuct*6.2832+rnd()*0.35,rr=0.45+0.40*rnd();
      var T=[cx+Math.cos(th)*s.rx*rr*sh.spread,cy+Math.sin(th)*s.ry*rr*sh.spread,s.wall];
      var prev=nip,path=[nip];
      for(var t=1;t<=4;t++){var f=t/4,p=inside([nip[0]+(T[0]-nip[0])*f,nip[1]+(T[1]-nip[1])*f,nip[2]+(T[2]-nip[2])*f],0);if(!p)break;path.push(p);}
      for(var e=1;e<path.length;e++)lines.push(path[e-1][0],path[e-1][1],path[e-1][2],path[e][0],path[e][1],path[e][2]);
      if(path.length<3)continue;
      var end=path[path.length-1],mid=path[Math.floor(path.length/2)],nl=Math.round((1.4+(i%2))*nLob);
      for(var j=0;j<nl;j++){
        var base=j<nl*0.7?end:mid,spr=0.0024+0.0012*Math.min(nl,6),r=(0.0019+rnd()*0.0012)*ls;
        var lp=inside([base[0]+(rnd()-0.5)*spr*2,base[1]+(rnd()-0.5)*spr*2,base[2]+(rnd()-0.3)*0.004],r*0.5);
        if(lp){pts.push(lp[0],lp[1],lp[2]);sizes.push(r);}
      }
    }
  });
  B.G={lines:new Float32Array(lines),pts:new Float32Array(pts),sizes:new Float32Array(sizes)};B.glKey=key;return B.G;
}
function drawBreast3D(g2,x0,y0,bw,bh,stage,S){
  var B=br3Init();if(!B)return null;
  try{
    var gl=B.gl,gc=B.g.cv,dpr=Math.min(2,window.devicePixelRatio||1),pw=Math.round(bw*dpr),ph=Math.round(bh*dpr);
    if(gc.width!==pw||gc.height!==ph){gc.width=pw;gc.height=ph;}
    var sh=br3Shape(stage);
    br3Morph(B,sh);
    var G=br3Glands(B,sh,S);
    var cyc=(B.br.L.cy+B.br.R.cy)/2,yaw=-0.50+0.10*Math.sin(Date.now()*0.0005),Sc=bh/0.25,ox=bw*0.50,oy=bh*0.5+cyc*Sc;
    gl.viewport(0,0,pw,ph);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(B.pr);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
    var u=B.u,a=B.a;gl.uniform1f(u.uYaw,yaw);gl.uniform1f(u.uS,Sc);gl.uniform1f(u.uOx,ox);gl.uniform1f(u.uOy,oy);gl.uniform1f(u.uW,bw);gl.uniform1f(u.uH,bh);gl.uniform1f(u.uPt,dpr);gl.uniform1f(u.uSee,1);
    var att=function(loc,buf,sz){if(loc<0)return;if(buf){gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,sz,gl.FLOAT,false,0,0);}else{gl.disableVertexAttribArray(loc);}};
    att(a.aN,null);att(a.aW,null);att(a.aA,null);gl.vertexAttrib3f(a.aN,0,0,1);gl.vertexAttrib1f(a.aW,0);gl.vertexAttrib1f(a.aA,0);
    // 1) body, solid; breast tissue tinted
    gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
    att(a.aP,B.bP,3);att(a.aN,B.bN,3);att(a.aW,B.bW,1);att(a.aA,B.bA,1);gl.uniform1f(u.uMode,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,B.bI);gl.drawElements(gl.TRIANGLES,B.ix.length,gl.UNSIGNED_SHORT,0);
    gl.disable(gl.CULL_FACE);
    // 2) glands as an x-ray overlay (they are clamped inside the breast, so they always land within it)
    att(a.aN,null);att(a.aA,null);gl.vertexAttrib3f(a.aN,0,0,1);gl.vertexAttrib1f(a.aA,0);att(a.aW,null);gl.vertexAttrib1f(a.aW,0);
    gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER,B.gP);gl.bufferData(gl.ARRAY_BUFFER,G.lines,gl.STREAM_DRAW);att(a.aP,B.gP,3);
    gl.uniform1f(u.uMode,1);gl.uniform3f(u.uCol,0.88,0.42,0.55);gl.drawArrays(gl.LINES,0,G.lines.length/3);
    gl.bindBuffer(gl.ARRAY_BUFFER,B.gP);gl.bufferData(gl.ARRAY_BUFFER,G.pts,gl.STREAM_DRAW);att(a.aP,B.gP,3);
    gl.bindBuffer(gl.ARRAY_BUFFER,B.gS);gl.bufferData(gl.ARRAY_BUFFER,G.sizes,gl.STREAM_DRAW);att(a.aW,B.gS,1);
    gl.uniform1f(u.uMode,2);gl.uniform3f(u.uCol,0.90,0.45,0.57);gl.drawArrays(gl.POINTS,0,G.sizes.length);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);
    g2.drawImage(gc,x0,y0,bw,bh);
    // screen anchors on the left breast for the labels: nipple, a duct, a lobule
    var c=Math.cos(yaw),s=Math.sin(yaw),pj=function(x,y,z){return [x0+ox+(x*c+z*s)*Sc,y0+oy-y*Sc];};
    var ap=B.br.L.apex,out={nipple:pj(ap[0],ap[1]+sh.droop,ap[2]+sh.grow),duct:null,lobule:null},Ln=G.lines,Pt=G.pts,best=-1;
    for(var k=0;k+5<Ln.length;k+=6)if(Ln[k]>0&&Ln[k+4]>Ln[k+1]+0.004){out.duct=pj((Ln[k]+Ln[k+3])/2,(Ln[k+1]+Ln[k+4])/2,(Ln[k+2]+Ln[k+5])/2);break;}
    for(k=0;k+2<Pt.length;k+=3)if(Pt[k]>0&&Pt[k+1]>best){best=Pt[k+1];out.lobule=pj(Pt[k],Pt[k+1],Pt[k+2]);}
    return out;
  }catch(e){BR3=false;return null;}
}
function drawBreastDev(cv){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  if(BDEV.animating){
    var el=(Date.now()-BDEV.t0)/1300, p=Math.min(1,el);
    var ease=p<0.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
    BDEV.stage=BDEV.fromStage+(BDEV.target-BDEV.fromStage)*ease;
    if(p>=1){BDEV.stage=BDEV.target;BDEV.animating=false;}
  }
  var S=devLerp(BDEV.stage);
  g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='left';
  var A=drawBreast3D(g,0,0,w,h,BDEV.stage,S);
  if(!A){g.fillStyle='rgba(147,163,186,.8)';g.textAlign='center';g.fillText('This 3D view needs WebGL, which this browser does not provide.',w/2,h/2);g.textAlign='left';return;}
  // labels on the model (right-hand column, thin leader lines)
  var lx=Math.min(w-92,A.nipple[0]+Math.max(46,h*0.22));
  var lab=function(t,ty,pt){if(!pt)return;g.strokeStyle='rgba(199,211,226,.55)';g.lineWidth=0.9;g.beginPath();g.moveTo(lx-4,ty-3);g.lineTo(pt[0],pt[1]);g.stroke();
    g.fillStyle='rgba(10,16,26,.55)';var tw=g.measureText(t).width;g.fillRect(lx-2,ty-10,tw+6,14);g.fillStyle='rgba(231,237,245,.95)';g.fillText(t,lx+1,ty);};
  lab('lobules',A.nipple[1]-h*0.20,A.lobule);
  lab('duct',A.nipple[1]-h*0.08,A.duct);
  lab('nipple',A.nipple[1]+h*0.06,A.nipple);
  // hormone bars
  g.fillStyle='rgba(10,16,26,.55)';g.fillRect(4,4,76,52);
  g.fillStyle='rgba(199,211,226,.85)';g.fillText('Estrogen',10,16);
  g.strokeStyle='rgba(147,163,186,.5)';g.lineWidth=1;g.strokeRect(10,20,60,6);
  g.fillStyle='#e58fb0';g.fillRect(10,20,60*Math.max(0,Math.min(1,S.estro/100)),6);
  g.fillStyle='rgba(199,211,226,.85)';g.fillText('Prolactin',10,40);
  g.strokeStyle='rgba(147,163,186,.5)';g.strokeRect(10,44,60,6);
  g.fillStyle='#e9c46a';g.fillRect(10,44,60*Math.max(0,Math.min(1,S.prl/100)),6);
}

var OV_DORMANT=[[-0.5,0.55,3],[0.45,0.42,2.3],[-0.15,-0.5,2.6],[0.55,-0.15,2]]; // small resting follicles for texture
function tubeGeom(w,h,ox,oy,orx,ory){
  var P0=[ox+orx*0.55, oy-ory*0.78];
  var C=[w*0.70, oy-h*0.28];
  var P2=[w*0.95, oy-h*0.40];
  function point(t){var u=1-t;return[u*u*P0[0]+2*u*t*C[0]+t*t*P2[0], u*u*P0[1]+2*u*t*C[1]+t*t*P2[1]];}
  function tangent(t){var u=1-t;var dx=2*u*(C[0]-P0[0])+2*t*(P2[0]-C[0]);var dy=2*u*(C[1]-P0[1])+2*t*(P2[1]-C[1]);var len=Math.hypot(dx,dy)||1;return[dx/len,dy/len];}
  function halfWidth(t){var f=Math.max(0,1-t/0.22);f=f*f;return 3.6+10*f;}
  return {P0:P0,C:C,P2:P2,point:point,tangent:tangent,halfWidth:halfWidth};
}
function drawOvulation(cv){
  var rect=cv.getBoundingClientRect();if(rect.width<2)return;var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.round(rect.width),h=Math.round(rect.height);if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var ox=w*0.35, oy=h*0.56, orx=w*0.155, ory=h*0.33;

  // --- fallopian tube: a real hollow tube (two walls, tapering), funnel-shaped opening near the ovary ---
  var TB=tubeGeom(w,h,ox,oy,orx,ory);
  var N=26, topPts=[], botPts=[];
  for(var i=0;i<=N;i++){
    var tt=i/N, p=TB.point(tt), tg=TB.tangent(tt), perp=[-tg[1],tg[0]], hw=TB.halfWidth(tt);
    topPts.push([p[0]+perp[0]*hw,p[1]+perp[1]*hw]);
    botPts.push([p[0]-perp[0]*hw,p[1]-perp[1]*hw]);
  }
  // rounded funnel mouth (infundibulum): bulge the rim outward at t=0, away from the tube direction
  var tg0=TB.tangent(0), mouthBulge=[TB.P0[0]-tg0[0]*6, TB.P0[1]-tg0[1]*6];

  var tubeGrad=g.createLinearGradient(topPts[0][0],topPts[0][1],botPts[N][0],botPts[N][1]);
  tubeGrad.addColorStop(0,'rgba(160,175,196,.30)');tubeGrad.addColorStop(1,'rgba(160,175,196,.16)');
  g.fillStyle=tubeGrad;
  g.beginPath();g.moveTo(mouthBulge[0],mouthBulge[1]);
  for(var i2=0;i2<=N;i2++) g.lineTo(topPts[i2][0],topPts[i2][1]);
  for(var i3=N;i3>=0;i3--) g.lineTo(botPts[i3][0],botPts[i3][1]);
  g.closePath();g.fill();
  g.strokeStyle='rgba(160,175,196,.6)';g.lineWidth=1.4;
  g.beginPath();g.moveTo(mouthBulge[0],mouthBulge[1]);for(var i4=0;i4<=N;i4++)g.lineTo(topPts[i4][0],topPts[i4][1]);g.stroke();
  g.beginPath();g.moveTo(mouthBulge[0],mouthBulge[1]);for(var i5=0;i5<=N;i5++)g.lineTo(botPts[i5][0],botPts[i5][1]);g.stroke();

  // fimbriae: fringe the funnel rim, curling toward the follicle site
  var fFollicleX=ox+orx*0.30, fFollicleY=oy-ory*0.42;
  g.strokeStyle='rgba(180,193,212,.7)';g.lineWidth=1.6;g.lineCap='round';
  for(var fi=0;fi<=6;fi++){
    var rt=fi/6;
    var rimX=botPts[0][0]+(topPts[0][0]-botPts[0][0])*rt, rimY=botPts[0][1]+(topPts[0][1]-botPts[0][1])*rt;
    var toward=[fFollicleX-rimX, fFollicleY-rimY]; var tl=Math.hypot(toward[0],toward[1])||1;
    var dirx=toward[0]/tl, diry=toward[1]/tl;
    var wig=(fi%2===0?1:-1)*3;
    var midX=rimX+dirx*7-diry*wig, midY=rimY+diry*7+dirx*wig;
    var endX=rimX+dirx*13, endY=rimY+diry*13;
    g.beginPath();g.moveTo(rimX,rimY);g.quadraticCurveTo(midX,midY,endX,endY);g.stroke();
  }
  g.fillStyle='rgba(180,193,212,.8)';g.font='10px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='left';g.fillText('fallopian tube (fimbriae)',w*0.52,oy-h*0.46);

  // --- ovary body: radial gradient for a fleshy, dimensional look, plus a few dormant follicles for texture ---
  var ovg=g.createRadialGradient(ox-orx*0.3,oy-ory*0.35,orx*0.15,ox,oy,orx*1.25);
  ovg.addColorStop(0,'#5a3440');ovg.addColorStop(0.55,'#42283320');ovg.addColorStop(0.55,'#3a2430');ovg.addColorStop(1,'#2a1a22');
  g.fillStyle=ovg;g.strokeStyle='#e7c6c0';g.lineWidth=1.6;
  g.beginPath();g.ellipse(ox,oy,orx,ory,0,0,6.2832);g.fill();g.stroke();
  for(var di=0;di<OV_DORMANT.length;di++){
    var d=OV_DORMANT[di];
    g.fillStyle='rgba(120,74,82,.55)';g.beginPath();g.arc(ox+d[0]*orx,oy+d[1]*ory,d[2],0,6.2832);g.fill();
    g.strokeStyle='rgba(200,160,166,.35)';g.lineWidth=0.8;g.stroke();
  }
  g.fillStyle='rgba(231,198,192,.8)';g.font='700 11px "IBM Plex Sans",Roboto,sans-serif';g.textAlign='center';g.fillText('Ovary',ox,oy+ory+16);g.textAlign='left';

  var t=OV.phase==='idle'?0:(Date.now()-OV.t0)/1000;
  var GROW=1.6, BURST=0.4, TRAVEL=1.9;
  var fx=fFollicleX, fy=fFollicleY; // follicle (Graafian follicle) site near the ovary wall

  function follicleFluid(r,eggR,eggOff){
    var fg=g.createRadialGradient(fx-r*0.25,fy-r*0.3,r*0.1,fx,fy,r);
    fg.addColorStop(0,'rgba(252,232,238,.95)');fg.addColorStop(0.65,'rgba(240,170,196,.9)');fg.addColorStop(1,'rgba(214,120,152,.95)');
    g.fillStyle=fg;g.beginPath();g.arc(fx,fy,r,0,6.2832);g.fill();
    g.strokeStyle='#f7d3e0';g.lineWidth=1.3;g.beginPath();g.arc(fx,fy,r,0,6.2832);g.stroke();
    if(eggR>0){
      var ex=fx+r*0.32*eggOff, ey=fy+r*0.30;
      var eg=g.createRadialGradient(ex-eggR*0.3,ey-eggR*0.3,eggR*0.1,ex,ey,eggR);
      eg.addColorStop(0,'#fff6f3');eg.addColorStop(0.7,'#f3c9cf');eg.addColorStop(1,'#d98fa0');
      g.fillStyle=eg;g.beginPath();g.arc(ex,ey,eggR,0,6.2832);g.fill();
      g.strokeStyle='#ffffff';g.lineWidth=0.9;g.beginPath();g.arc(ex,ey,eggR,0,6.2832);g.stroke();
      return [ex,ey];
    }
    return [fx,fy];
  }

  function drawEgg(px,py,alpha){
    var eg=g.createRadialGradient(px-3,py-3,1,px,py,4.6);
    eg.addColorStop(0,'#fff6f3');eg.addColorStop(0.7,'#f3c9cf');eg.addColorStop(1,'#d98fa0');
    g.globalAlpha=alpha;g.fillStyle=eg;g.beginPath();g.arc(px,py,4.4,0,6.2832);g.fill();
    g.strokeStyle='rgba(255,255,255,.8)';g.lineWidth=1;g.beginPath();g.arc(px,py,4.4,0,6.2832);g.stroke();
    g.globalAlpha=1;
  }

  if(OV.phase==='idle'){
    g.fillStyle='rgba(122,74,82,.6)';g.beginPath();g.arc(fx,fy,4,0,6.2832);g.fill();
    return;
  }
  if(OV.phase==='growing'){
    var p=Math.min(1,t/GROW), ease=1-Math.pow(1-p,2);
    var r=4+ease*17;
    follicleFluid(r, 2+ease*2.6, 1);
    if(p>=1){OV.phase='rupture';OV.t0=Date.now();}
  } else if(OV.phase==='rupture'){
    var p2=Math.min(1,t/BURST);
    var r=21*(1-p2*0.35);
    follicleFluid(r, 4.6*(1-p2*0.2), 1);
    g.globalAlpha=1;
    for(var k=0;k<10;k++){
      var a=k/10*6.2832+0.3;
      var rr=r*0.9+p2*(16+6*Math.sin(k*2.1));
      var dropR=(1.6+1.4*Math.sin(k*1.7))*(1-p2*0.4);
      g.fillStyle='rgba(247,211,224,'+(0.85*(1-p2))+')';
      g.beginPath();g.arc(fx+Math.cos(a)*rr,fy+Math.sin(a)*rr,Math.max(0.4,dropR),0,6.2832);g.fill();
    }
    if(p2<0.5){g.fillStyle='rgba(255,255,255,'+(0.5*(1-p2*2))+')';g.beginPath();g.arc(fx,fy,r*1.15,0,6.2832);g.fill();}
    if(p2>=1){OV.phase='released';OV.t0=Date.now();}
  } else if(OV.phase==='released'){
    var p3=Math.min(1,t/TRAVEL);
    var APPROACH=0.20; // fraction of travel spent reaching the funnel mouth before entering the tube
    var mouthPt=TB.point(0);
    if(p3<APPROACH){
      var pa=p3/APPROACH, easeA=1-Math.pow(1-pa,2);
      var px=fx+(mouthPt[0]-fx)*easeA, py=fy+(mouthPt[1]-fy)*easeA;
      drawEgg(px,py,1);
    } else {
      var pb=(p3-APPROACH)/(1-APPROACH);
      var easeB=pb<0.5?2*pb*pb:1-Math.pow(-2*pb+2,2)/2;
      var pos=TB.point(easeB), tg=TB.tangent(easeB), perp=[-tg[1],tg[0]];
      var hw=TB.halfWidth(easeB);
      var wob=Math.sin(t*9)*Math.min(1,hw*0.35)*(1-pb*0.5);
      var px2=pos[0]+perp[0]*wob, py2=pos[1]+perp[1]*wob;
      drawEgg(px2,py2,1-pb*0.08);
      var capEl=document.getElementById('ovCap');
      if(capEl && capEl.dataset.stage!=='3'){capEl.dataset.stage='3';capEl.innerHTML='3 \u2014 The <b>fimbriae</b> sweep the egg into the fallopian tube, where it may be fertilised.';}
    }
    if(p3>=1){OV.phase='done';var pb2=document.getElementById('ovPlay');if(pb2)pb2.disabled=false;}
  }
}
function runOvulation(){
  if(OV.phase==='growing'||OV.phase==='rupture'||OV.phase==='released')return;
  var pb=document.getElementById('ovPlay');if(pb)pb.disabled=true;
  var cap=document.getElementById('ovCap');
  if(cap){cap.dataset.stage='1';cap.innerHTML='1 \u2014 Rising <b>estrogen</b> matures a follicle inside the ovary.';}
  OV.phase='growing';OV.t0=Date.now();
  setTimeout(function(){if(cap && OV.phase==='rupture'){cap.dataset.stage='2';cap.innerHTML='2 \u2014 The mature follicle <b>ruptures</b> \u2014 this release is called <b>ovulation</b>.';}},1450);
}
function renderGland(cv,id,ang){
  var o=ORGANS.find(function(x){return x.id===id;});if(!o)return;
  var rect=cv.getBoundingClientRect();var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));
  if(cv.width!==w*dpr||cv.height!==h*dpr){cv.width=w*dpr;cv.height=h*dpr;}
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  var mx=0;for(var a=0;a<o._faces.length;a++)for(var b=0;b<o._faces[a].length;b++){var v=o._faces[a][b],dx=v[0]-o._center[0],dy=v[1]-o._center[1],dz=v[2]-o._center[2];var m=Math.hypot(dx,dy,dz);if(m>mx)mx=m;}
  var S=Math.min(w,h)*0.40/mx,dist=420,draws=[];
  var sq=(id==='uterus')?uterusSqueeze():0;
  if(id==='uterus')ACT.uterus=0.2+0.8*sq;
  var us=1;if(id==='thyroid'){us=1+GOI*0.55;}
  for(var i=0;i<o._faces.length;i++){var f=o._faces[i];
    var cam=f.map(function(v){var vx=(v[0]-o._center[0])*us,vy=(v[1]-o._center[1])*us,vz=(v[2]-o._center[2])*us;if(sq){vx*=(1-0.22*sq);vz*=(1-0.22*sq);vy*=(1+0.06*sq);}return rotate([vx,vy,vz],0.2,ang);});
    var n=rotate(o._fn[i],0.2,ang);var nz=n[2];if(nz<=0.02)continue;
    var pr=cam.map(function(p){var f2=dist/(dist-p[2]*S);return[w/2+p[0]*S*f2,h/2-p[1]*S*f2];});
    var d=0;cam.forEach(function(p){d+=p[2];});d/=cam.length;draws.push({d:d,pr:pr,c:css(shadeFace(COL[o.id],n,nz,i))});
  }
  draws.sort(function(a,b){return a.d-b.d;});
  for(var k=0;k<draws.length;k++){var dr=draws[k];g.beginPath();g.moveTo(dr.pr[0][0],dr.pr[0][1]);for(var q=1;q<dr.pr.length;q++)g.lineTo(dr.pr[q][0],dr.pr[q][1]);g.closePath();g.fillStyle=dr.c;g.fill();g.strokeStyle=dr.c;g.lineWidth=0.4;g.stroke();}
}

loadSavedImages();
var exportBtnEl=document.getElementById('exportBtn');
if(exportBtnEl) exportBtnEl.onclick=exportHTML;
/* ===== Credits (the round "i" button) =====
   Add one entry per third-party asset. CC BY licences require: title, author, licence and a note of
   any changes made. */
var CREDITS=[
  {use:'Main 3D body \u2014 male',title:'Basic humen body',url:'https://www.fab.com/listings/5bd2e525-57e7-4989-9f56-11507be57511',
   author:'Optic Idealist',authorUrl:'https://www.fab.com/sellers/Optic%20Idealist',license:'via Fab',
   changes:'scaled, simplified for the browser, glands placed inside'},
  {use:'Main 3D body \u2014 female',title:'Female body base',url:'https://www.fab.com/listings/60ca248c-f02f-4866-b5f7-06a27682b7e2',
   author:'Dori Mur',authorUrl:'https://www.fab.com/sellers/Dori%20Mur',license:'via Fab',
   changes:'scaled, simplified for the browser, glands placed inside'},
  {use:'3D beating heart (Adrenal lab)',title:'Realistic Human Heart',url:'https://skfb.ly/oyBCT',
   author:'neshallads',authorUrl:'https://sketchfab.com/neshallads',license:'CC BY 4.0',licenseUrl:'http://creativecommons.org/licenses/by/4.0/',
   changes:'textures resized; animated cardiac cycle added'},
  {use:'Growth hormone figure \u2014 male',title:'Free Pack - Male Base Mesh',url:'https://www.fab.com/listings/6ea2f53a-fe66-4c16-8a6b-7ffa2037075c',
   author:'PolyOne Studio',authorUrl:'https://www.fab.com/sellers/PolyOne%20Studio',license:'via Fab',
   changes:'reshaped to show dwarfism and gigantism'},
  {use:'Growth hormone figure \u2014 female',title:'Free Pack - Female Base Mesh',url:'https://www.fab.com/listings/ed8bc44c-7edb-4ebb-bc10-1f720798b0b8',
   author:'PolyOne Studio',authorUrl:'https://www.fab.com/sellers/PolyOne%20Studio',license:'via Fab',
   changes:'reshaped to show dwarfism and gigantism'},
  {use:'Realistic gland and tissue images',text:'Rendered by Draven Ashcroft, assisted by OpenAI GPT\u20115.7.'}
];
var CREDITS_FONTS='Fonts: <a href="https://fonts.google.com/specimen/IBM+Plex+Sans" target="_blank" rel="noopener">IBM Plex Sans</a> (SIL Open Font License) and <a href="https://fonts.google.com/specimen/Roboto" target="_blank" rel="noopener">Roboto</a> (Apache 2.0), via Google Fonts.';
function creditsHTML(){
  var esc=function(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');};
  var link=function(txt,url){return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(txt)+'</a>':esc(txt);};
  var h='<h3>Credits</h3>';
  CREDITS.forEach(function(c){
    if(c.text){h+='<div class="cr"><div class="crw">'+esc(c.use)+'</div>'+esc(c.text)+'</div>';return;}
    h+='<div class="cr"><div class="crw">'+esc(c.use)+'</div>“'+link(c.title,c.url)+'” by '+link(c.author,c.authorUrl)+
      (c.license?' · '+link(c.license,c.licenseUrl):'')+(c.changes?'<br><span>Changes: '+esc(c.changes)+'</span>':'')+'</div>';
  });
  h+='<div class="cr">'+CREDITS_FONTS+'</div>';
  h+='<div class="crnote">Corpus Glandula — Endocrine System Simulator, Class 10 CBSE.</div>';
  return h;
}
(function(){
  var btn=document.getElementById('infoBtn'),card=document.getElementById('creditsCard');if(!btn||!card)return;
  var set=function(open){if(open)card.innerHTML=creditsHTML();card.hidden=!open;btn.classList.toggle('on',open);btn.setAttribute('aria-expanded',open?'true':'false');};
  btn.onclick=function(){set(card.hidden);};
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!card.hidden)set(false);});
})();
var jsonBtnEl=document.getElementById('jsonBtn');
if(jsonBtnEl) jsonBtnEl.onclick=exportJSON;
try{if(window.matchMedia&&matchMedia('(pointer:coarse)').matches)document.getElementById('hint').textContent='Drag to rotate \u00b7 pinch to zoom \u00b7 tap a gland \u00b7 hold for hormones';}catch(e){}
buildList();renderTabbar();activateTab('home');tick();
if(SNAPSHOT_STATE)applyState(SNAPSHOT_STATE);
