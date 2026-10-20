/* ══════════════════════════════════════════════════════════════
   OcuScan Pro — Client (index.js)  TAMPER-PROOF VERSION
   
   SECURITY: This file contains ZERO scoring logic.
   - Server generates all questions and stores correct answers
   - Client only renders what server sends + forwards raw user input
   - Session token required for every API call (prevents forging)
   - Correct answers NEVER sent to client — server validates all answers
══════════════════════════════════════════════════════════════ */

// LOCAL-DEV: index.html is opened directly from disk (file://) while the
// Express API runs separately on localhost:3000 (`node server.js`).
// file:// pages report location.hostname === '' and location.protocol === 'file:',
// so we check for that explicitly and always point at the local server.
const RAILWAY_API_URL = (() => {
  const base = (typeof window !== 'undefined' && window.ENV_API_URL) || '';
  if (base) return base.replace(/\/+$/, '');
  if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return base; // empty string = same-origin (production deployment)
})();

/* ── SESSION CREDENTIALS (set on /api/session/create) ── */
let _sessionId = null;
let _sessionToken = null;

/* ══ PARTICLE BACKGROUND ══════════════════════════════════════ */
(() => {
    const c=document.getElementById('bg-canvas'),ctx=c.getContext('2d');
    let W,H,pts=[];
    const resize=()=>{W=c.width=window.innerWidth;H=c.height=window.innerHeight};
    window.addEventListener('resize',resize);resize();
    // PERF: Fewer particles on mobile — O(n²) connection checks removed entirely
    const isMobile=window.innerWidth<768||navigator.hardwareConcurrency<4;
    const COUNT=isMobile?20:40;
    for(let i=0;i<COUNT;i++)pts.push({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.2,vy:(Math.random()-.5)*.2,r:Math.random()*1.2+.4,a:Math.random()*.5+.15});
    const draw=()=>{ctx.clearRect(0,0,W,H);pts.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(0,212,255,${p.a*.22})`;ctx.fill()});requestAnimationFrame(draw)};
    // Respect reduced-motion preference
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)draw();
})();

/* ══ MAIN APP ═════════════════════════════════════════════════ */
const App = (() => {

    // SAFETY FIX: GSAP loads from an external CDN with no onerror handling.
    // If it fails (CDN outage, ad-blocker, flaky connection) every unguarded
    // gsap.X() call below would throw — and several sit directly in test-finish
    // paths right before the critical setTimeout(advanceSequence,...) line, which would
    // permanently freeze that screen. This shim makes the whole file gsap-safe
    // in one place: real GSAP when available, silent no-op (still firing
    // onComplete, so dependent UI state still updates) when it isn't.
    const gsap = window.gsap || {
        to:(t,o)=>{o&&o.onComplete&&o.onComplete();return{}},
        from:()=>({}),
        fromTo:(t,f,o)=>{o&&o.onComplete&&o.onComplete();return{}},
    };

    /* ── CONSTANTS ─────────────────────────────────────────────── */
    // BUG-07 FIX: 73° was a rear-camera FOV figure. This app uses the FRONT (selfie)
    // camera exclusively — front camera FOV runs ~62° (iPhone) to ~80° (Samsung Galaxy),
    // averaging closer to 65°. The old value inflated computed distance by up to 15%,
    // which directly inflated Snellen letter size by the same margin.
    const TYPICAL_DIAG_FOV = 65*(Math.PI/180);
    // SCI-06: Iris diameter varies 10.2–13.0mm across populations (mean 11.7mm).
    // A ±11% error = ±1 Snellen line. Allow user override from contact-lens Rx.
    const IRIS_MM = parseFloat(localStorage.getItem('ocu_iris_mm') || '11.7');
    const RULER_MM = 20; // 2cm — the physical reference the user matches with a real ruler

    /* ── STATE (UI/camera only — no answers, no correctness) ────── */
    let S = {
        screen:'calib', stream:null, cameraOk:false,
        mpReady:false, mpFaceMesh:null,
        irisPixels:null, distanceCm:null, bothEyesOpen:false, distHistory:[],
        calibPPMM:null, calibDPI:null, cardWidthPx:null, calibDone:false,
        currentEye:'OD',
        diopterPhase:1,  // local tracking only for UI
        patientName:'',
        completed:{},    // mirrors server completed — for menu badges only
    };

    /* ── DOM / HELPERS ─────────────────────────────────────────── */
    const TTS = {
        voice:null,
        _userInteracted: false,
        init(){
            const set=()=>{const v=speechSynthesis.getVoices();this.voice=v.find(v=>v.name.includes('Samantha')||v.name.includes('Google UK English Female'))||v[0]};
            speechSynthesis.onvoiceschanged=set;set();
            // Track first user interaction — required by browsers before TTS can fire
            const markInteracted=()=>{this._userInteracted=true;['click','touchstart','keydown'].forEach(e=>document.removeEventListener(e,markInteracted))};
            ['click','touchstart','keydown'].forEach(e=>document.addEventListener(e,markInteracted,{once:true,passive:true}));
        },
        _ttsMuted: false,
        say(t,p=false){
            if(this._ttsMuted||!this._userInteracted)return;
            const now=Date.now();
            if(!p&&t===this._last&&now-this._lastAt<8000)return; // the same sentence twice in a row is noise
            this._last=t;this._lastAt=now;
            speechSynthesis.cancel();
            const u=new SpeechSynthesisUtterance(t);u.voice=this.voice;u.rate=.92;u.pitch=1.05;u.volume=1;speechSynthesis.speak(u)
        },
        stop(){speechSynthesis.cancel()},
        toggle(){this._ttsMuted=!this._ttsMuted;const btn=document.getElementById('tts-toggle');if(btn)btn.title=this._ttsMuted?'Enable voice':'Disable voice';if(btn)btn.textContent=this._ttsMuted?'🔇':'🔊';if(!this._ttsMuted)this.say('Voice enabled.')},
    };
    TTS.init();
    // One spoken lead-in per eye (used by every test) — says which eye to test and which to cover.
    const _eyeLead=()=>S.currentEye==='OD'?'Right eye.':'Now your left eye.';

    const $=id=>document.getElementById(id);
    const el=(tag,cls,html)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(html)e.innerHTML=html;return e};
    function showScreen(name){
        TTS.stop();
        // BUGFIX: eye-switches (Near/Diopter OD→OS) call showScreen() with the
        // SAME name that's already active, to refresh content in place. The
        // full remove/re-add-.active dance below is what the GSAP entrance
        // animation (MutationObserver-driven) keys off — re-running it for a
        // screen that's already showing caused a visible blank flash on every
        // eye switch. Skip that dance when we're not actually changing screens.
        const target=$('screen-'+name);
        const alreadyActive = S.screen===name && target && target.classList.contains('active');
        if(!alreadyActive){
            // A11Y: deactivate all screens properly — remove from tab order
            document.querySelectorAll('.screen').forEach(s=>{
                s.classList.remove('active');
                if(s!==target&&window.gsap){window.gsap.killTweensOf(s);s.style.opacity='';s.style.transform=''} // FIX: never leave an old screen painted by a stale inline style
                s.setAttribute('aria-hidden','true');
                s.querySelectorAll('a,button,input,select,textarea,[tabindex]').forEach(el=>el.setAttribute('tabindex','-1'));
            });
            const t=$('screen-'+name);if(!t)return;
            t.classList.add('active');
            t.scrollTop = 0; // BUGFIX-15: always open a screen scrolled to top, so .test-header never reopens hidden behind the fixed #top-nav at a stale scroll position
            t.setAttribute('aria-hidden','false');
            // Restore tab order on active screen
            t.querySelectorAll('[tabindex="-1"]').forEach(el=>el.removeAttribute('tabindex'));
        }
        S.screen=name;
        // REFACTOR-07: Allow scrolling on content-heavy screens
        const scrollable=['results','menu'].includes(name);
        document.body.style.overflow=scrollable?'auto':'hidden';
        document.documentElement.style.overflow=scrollable?'auto':'hidden';
        const ts=['snellen','near'];
        const safe=(id,p,v)=>{const e=$(id);if(e)e.style[p]=v};
        safe('prog-wrap','display',ts.includes(name)?'block':'none');
        // The results page is deliberately clean: no camera preview, distance/eye pills or accuracy banner on top of it.
        const _onRes=name==='results';
        safe('pip','display',(S.cameraOk&&!_onRes)?'flex':'none');
        safe('nav-dist-pill','display',(S.cameraOk&&!_onRes)?'block':'none');
        if(_onRes){safe('nav-eye-pill','display','none');safe('accuracy-banner','display','none');window.GESTUREALERT&&window.GESTUREALERT.reset()}
        else if(['snellen','near','contrast','diopter'].includes(name)){updateEyePill();_showAccuracyBanner()}
        // D1: update progress stepper
        const testNames=['snellen','near','contrast','diopter'];
        if(typeof _updateStepper==='function')_updateStepper(testNames.includes(name)?name:null);
        // A11Y: Move focus to first meaningful element after transition
        setTimeout(()=>{
            // FIX: `t` only exists inside the if-block above → "t is not defined" on every screen change.
            // Use `target`, and only ever focus a heading (never the ✕ Exit button).
            const first=target&&target.querySelector('h1,h2,[role="heading"]');
            if(first){if(!first.hasAttribute('tabindex'))first.setAttribute('tabindex','-1');first.focus({preventScroll:true})}
        },50);
    }
    // ANIM-05: Smooth lerp progress bar — no step jumps, glow on edge
    let _progTarget = 0, _progCurrent = 0, _progRaf = null;
    function setProgress(p) {
        _progTarget = Math.max(0, Math.min(100, p));
        if (_progRaf) return;
        const tick = () => {
            const diff = _progTarget - _progCurrent;
            if (Math.abs(diff) < 0.3) {
                _progCurrent = _progTarget;
                _progRaf = null;
            } else {
                _progCurrent += diff * 0.12;
                _progRaf = requestAnimationFrame(tick);
            }
            const f = $('prog-fill');
            if (f) {
                f.style.width = _progCurrent + '%';
                f.style.boxShadow = _progCurrent > 2 ? '2px 0 8px rgba(26,86,219,.55)' : 'none';
            }
        };
        _progRaf = requestAnimationFrame(tick);
    }
    function toast(msg,ms=3200){const t=$('toast');if(!t)return;t.innerHTML=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),ms)}
    function setCheck(id,cls,icon,val=''){const e=$(id);if(!e)return;e.className='chk'+(cls?' '+cls:'');const i=e.querySelector('.chk-icon');if(i)i.textContent=icon;const v=e.querySelector('.chk-val');if(v)v.textContent=val}

    /* ── API HELPER ─────────────────────────────────────────────── */
    async function api(path, body={}) {
        // Guard: no point making API calls without a valid session
        if (!_sessionId || !_sessionToken) {
            throw new Error('No active session — please refresh the page.');
        }
        const MAX_ATTEMPTS = 3;
        const DELAYS = [1000, 2000, 4000];
        let lastErr;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const res = await fetch(RAILWAY_API_URL + path, {
                    method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({sessionId:_sessionId, token:_sessionToken, ...body}),
                });
                if (!res.ok) {
                    const err = await res.json().catch(()=>({error:'Network error'}));
                    const e = new Error(err.error || 'API error');
                    e.status = res.status;
                    if (res.status === 401 || res.status === 403) {
                        e.sessionExpired = true;
                        _sessionId = null; _sessionToken = null; // invalidate locally
                    }
                    throw e;
                }
                return await res.json();
            } catch(e) {
                lastErr = e;
                if (e.status && e.status >= 400 && e.status < 500) throw e;
                if (attempt < MAX_ATTEMPTS - 1) {
                    await new Promise(r => setTimeout(r, DELAYS[attempt]));
                }
            }
        }
        throw lastErr;
    }

    async function createSession() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
        try {
            const res = await fetch(RAILWAY_API_URL + '/api/session/create', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({patientName: S.patientName, calibPPMM: S.calibPPMM, calibDone: S.calibDone}),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!res.ok) {
                const err = await res.json().catch(() => ({error: 'Server error'}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            if (!data.ok) throw new Error('Session creation failed');
            _sessionId    = data.sessionId;
            _sessionToken = data.token;
        } catch(e) {
            clearTimeout(timeout);
            if (e.name === 'AbortError') throw new Error('Server timeout — check your connection.');
            throw e;
        }
    }

    function _showAccuracyBanner(){
        // UX-08: Warn users when both camera AND calibration are absent
        if(!S.cameraOk && !S.calibDone){
            let b=document.getElementById('accuracy-banner');
            if(!b){
                b=document.createElement('div');b.id='accuracy-banner';
                b.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:800;background:rgba(255,184,48,.12);border-top:1px solid rgba(255,184,48,.3);padding:8px 20px;text-align:center;font-size:13px;color:#ffb830;display:none;';
                b.innerHTML='⚠ <strong>Reduced accuracy mode</strong> — No camera or calibration. Results are estimates only. <span style="opacity:.7;font-size:12px;">Enable camera for better accuracy.</span>';
                document.body.appendChild(b);
            }
            b.style.display='block';
        }
    }

    async function syncSession() {
        await api('/api/session/update', {
            calibPPMM:S.calibPPMM, calibDone:S.calibDone,
            distanceCm:S.distanceCm, eye:S.currentEye,
            patientName:S.patientName
        });
    }

    /* ══ GESTURE ALERTS ══════════════════════════════════════════ */
    const GESTUREALERT = (() => {
        let _cur=null,_dismissed=new Set(),_coverShown=null,_coverOkShown=false,_lastDist=null,_noFace=0,_distCD=0,_timer=null;
        // Track whether cover instruction was already shown ONCE per eye/test session
        let _coverInstructionShownOnce=false;
        const A={
            // OD = Right Eye being tested → cover LEFT eye (left side of mirrored screen = user's left)
            'cover-od':{emoji:'🤚',type:'warn',title:'Cover Your Left Eye',msg:'Close or cover your left eye to begin.',tts:null,duration:3500,dismissable:true},
            // OS = Left Eye being tested → cover RIGHT eye (right side of mirrored screen = user's right)
            'cover-os':{emoji:'🤚',type:'warn',title:'Cover Your Right Eye',msg:'Close or cover your right eye to begin.',tts:null,duration:3500,dismissable:true},
            'cover-ok':{emoji:'✅',type:'success',title:'Eye Covered!',msg:'Keep hand firmly over the eye throughout the test.',tts:'Eye covered.',duration:2200,dismissable:true},
            'uncover-warn':{emoji:'⚠️',type:'error',title:'Both Eyes Open!',msg:'Cover the required eye to continue.',tts:'Cover one eye.',duration:8000,dismissable:true},
            'no-face':{emoji:'🔍',type:'warn',title:'No Face Detected',msg:'Position your face in front of the camera.',tts:'No face detected.',duration:0,dismissable:true},
            'too-far':{emoji:'📏',type:'warn',title:'Too Far',msg:'Move closer. Optimal: 40–70 cm.',tts:'Move closer.',duration:5000,dismissable:true},
            'too-close':{emoji:'📏',type:'warn',title:'Too Close',msg:'Move back. Optimal: 40–70 cm.',tts:'Move back.',duration:5000,dismissable:true},
            'hold-40cm':{emoji:'📐',type:'info',title:'Hold at 40cm',msg:'Hold screen at arm length (~40 cm).',tts:null,duration:4000,dismissable:true},
            'both-open-info':{emoji:'✅',type:'success',title:'Both Eyes Detected',msg:'Camera working correctly.',tts:'Good.',duration:3000,dismissable:true},
        };
        function _show(key){const cfg=A[key];if(!cfg||_dismissed.has(key))return;if(_cur===key)return;if(S.screen==='results')return;/* FIX: idempotent — tick() runs every camera frame; re-arming the timer (and re-speaking TTS) kept toasts on screen forever */if(_timer){clearTimeout(_timer);_timer=null}_cur=key;const ga=$('gesture-alert');if(!ga)return;$('ga-emoji').textContent=cfg.emoji;$('ga-title').textContent=cfg.title;$('ga-msg').textContent=cfg.msg;if($('ga-sub'))$('ga-sub').textContent='';if($('ga-dismiss'))$('ga-dismiss').style.display='flex';ga.className='ga-show '+(cfg.type||'warn');ga.style.display='flex';if(cfg.tts)TTS.say(cfg.tts);if(cfg.duration>0)_timer=setTimeout(()=>{ga.style.display='none';_cur=null;_dismissed.add(key)},cfg.duration)}
        function _hide(key){if(_cur!==key)return;const ga=$('gesture-alert');if(ga)ga.style.display='none';_cur=null}
        return {
            dismiss(){if(_cur){_dismissed.add(_cur);const ga=$('gesture-alert');if(ga)ga.style.display='none';_cur=null;if(_timer){clearTimeout(_timer);_timer=null}}},
            reset(){_dismissed=new Set();_coverShown=null;_coverOkShown=false;_coverInstructionShownOnce=false;_lastDist=null;_noFace=0;/* FIX: don't carry a toast over into the next eye/test */if(_timer){clearTimeout(_timer);_timer=null}_cur=null;const _ga=$('gesture-alert');if(_ga)_ga.style.display='none'},
            tick(lm,lo,ro,dist){
                if(!lm){_noFace++;if(_noFace>90&&!_dismissed.has('no-face'))_show('no-face');return}_noFace=0;if(_cur==='no-face')_hide('no-face');
                if(S.screen==='setup'){if(lo&&ro&&!_dismissed.has('both-open-info'))_show('both-open-info');else if(_cur==='no-face'||_cur==='both-open-info')_hide(_cur);return}
                // BUG-06 FIX (root cause): near vision is binocular — eye-cover enforcement
                // must NEVER apply to it. Distance feedback is still useful for both tests.
                const coverGated=['snellen'], distGated=['snellen','near'];
                if(coverGated.includes(S.screen)&&S.currentEye){
                    const ok=S.currentEye==='OD'?!lo:!ro;
                    // Show cover instruction ONCE per eye test session only
                    if(!ok&&!_coverInstructionShownOnce&&_coverShown!==S.currentEye){
                        _coverShown=S.currentEye;_coverOkShown=false;_coverInstructionShownOnce=true;
                        _show(S.currentEye==='OD'?'cover-od':'cover-os');return
                    }
                    if(ok&&!_coverOkShown&&_coverShown===S.currentEye){_coverOkShown=true;_show('cover-ok');return}
                    // Protocol violation: both eyes open after instruction was already given — brief dismissable warning, not persistent loop
                    if(!ok&&lo&&ro){if(_cur!=='uncover-warn'&&!_dismissed.has('uncover-warn'))_show('uncover-warn');return}
                    if(ok&&_cur==='uncover-warn')_hide('uncover-warn')
                }
                if(distGated.includes(S.screen)&&dist){const now=Date.now();if(now>_distCD){if(dist>70){if(_lastDist!=='too-far'){_lastDist='too-far';_distCD=now+8000;_show('too-far')}}else if(dist<40){if(_lastDist!=='too-close'){_lastDist='too-close';_distCD=now+8000;_show('too-close')}}else{if(_lastDist&&(_cur==='too-far'||_cur==='too-close')){_lastDist=null;_hide(_cur)}}}}
                if(S.screen==='near'&&!_dismissed.has('hold-40cm')){_show('hold-40cm');_dismissed.add('hold-40cm')}/* FIX: once per Near test */
            },
            onTestStart(name,eye){
                this.reset();
                // Reset EAR sustained-closure state so old values don't bleed into new test
                S._earState=null; S._pvTimer&&clearTimeout(S._pvTimer); S._pvTimer=null; S._pvSus=false; S._pvActive=false;
                if($('pv-overlay'))$('pv-overlay').style.display='none';
                ['opto-stage','near-canvas','near-stage'].forEach(id=>{const e=$(id);if(e)e.style.visibility='visible'});
            },
            onEyeSelected(eye){_coverShown=null;_coverOkShown=false;_coverInstructionShownOnce=false},
        };
    })();
    window.GESTUREALERT=GESTUREALERT;
    // Expose TTS globally so nav button onclick can reach it
    window.TTS=TTS;

    /* ── MEDIAPIPE ──────────────────────────────────────────────── */
    // Extra EAR landmarks for robust open/closed detection
    // Horizontal corners for normalization
    const L_EYE_H_L=33,L_EYE_H_R=133; // left eye horizontal
    const R_EYE_H_L=362,R_EYE_H_R=263; // right eye horizontal
    // Full 6-point EAR for each eye
    const L_EAR_TOP=[159,158],L_EAR_BOT=[145,153];
    const R_EAR_TOP=[386,385],R_EAR_BOT=[374,380];
    const LEFT_IRIS=[468,469,470,471,472],RIGHT_IRIS=[473,474,475,476,477];

    let _mpInitializing = false;
    async function initMediaPipe(){
        // Prevent double-init (called from both init() background and startCamera())
        if (S.mpReady || _mpInitializing) return;
        _mpInitializing = true;
        if($('load-sub'))$('load-sub').textContent='Loading camera AI (1/2)…';
        // PERF-02: Lazy-load the ~8MB MediaPipe scripts only now
        if (window._loadMediaPipe) {
            try { await window._loadMediaPipe(); if($('load-sub'))$('load-sub').textContent='AI loaded — initialising (2/2)…'; }
            catch(e) { S.mpReady=false; _mpInitializing=false; if($('load-sub'))$('load-sub').textContent='Camera features unavailable — manual mode.'; toast('📷 Manual mode — enter your distance below.',5000); return; }
        }
        const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),8000));
        try{
            await Promise.race([
                (async()=>{
                    S.mpFaceMesh=new FaceMesh({locateFile:f=>`${window._mpBase||'mediapipe/'}${f}`});
                    const isMobile=/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
                    S.mpFaceMesh.setOptions({maxNumFaces:1,refineLandmarks:true,
                        minDetectionConfidence:isMobile?.45:.6,
                        minTrackingConfidence:isMobile?.40:.5});
                    S.mpFaceMesh.onResults(onFaceResults);
                })(),
                timeout
            ]);
            S.mpReady=true; _mpInitializing=false; if($('load-sub'))$('load-sub').textContent='Camera ready.';
        }
        catch(e){
            S.mpReady=false; _mpInitializing=false;
            if($('load-sub'))$('load-sub').textContent='Camera features unavailable — continuing in manual mode.';
            toast('📷 Running in manual mode — enter your distance below.',5000);
        }
    }

    function onFaceResults(results){
        S._mpGotResult=true;
        const lm=results.multiFaceLandmarks?.[0];
        if(!lm){S.irisPixels=null;S.distanceCm=null;S.bothEyesOpen=false;S.distHistory=[];updateDistUI(null);GESTUREALERT.tick(null,false,false,null);return}
        const vid=$('setup-video').videoWidth?$('setup-video'):$('pip-video');
        const W=vid.videoWidth||640,H=vid.videoHeight||480;
        const diagPx=Math.sqrt(W*W+H*H),focalPx=(diagPx/2)/Math.tan(TYPICAL_DIAG_FOV/2);
        const ri=RIGHT_IRIS.map(i=>lm[i]);
        const irisDiamPx=Math.sqrt(Math.pow((ri[1].x-ri[3].x)*W,2)+Math.pow((ri[1].y-ri[3].y)*H,2));
        if(irisDiamPx>4){
            S.irisPixels=irisDiamPx;
            const rawCm=((IRIS_MM*focalPx)/irisDiamPx)/10;
            if(rawCm<5||rawCm>200){updateDistUI(S.distanceCm);return}
            // PERF: Smaller history = more responsive (4 frames ~133ms)
            S.distHistory.push(rawCm);
            if(S.distHistory.length>4)S.distHistory.shift();
            const sorted=[...S.distHistory].sort((a,b)=>a-b);
            const median=sorted[Math.floor(sorted.length/2)];
            // Higher alpha = snappier tracking
            const prev=S.distanceCm||median;
            const sm=(0.5*median)+(0.5*prev);
            // Reduced jitter threshold for smoother feel
            if(S.distanceCm!==null&&Math.abs(sm-S.distanceCm)<1.0){return}
            S.distanceCm=Math.round(sm*10)/10;S._lastDistUpdate=Date.now();
            updateDistUI(S.distanceCm);updateHUDLabels(irisDiamPx,S.distanceCm);
            if(S.screen==='snellen'&&_currentSnellenQ){
                _debouncedSnellenResize(_currentSnellenQ.pxH,S.distanceCm);
            }
            if(S.screen==='near'&&_nearQ){
                _debouncedNearResize();
            }
        }

        /* ══════════════════════════════════════════════════════════════
           TEMP BYPASS — eye open/closed detection disabled.
           Reason: the geometric EAR/iris heuristic below isn't reliable
           enough yet (misses hand-covering and, sometimes, genuinely
           closed eyes). A dedicated ML classifier is being trained to
           replace it. Until it's wired in, real detection is commented
           out below and replaced with a SIMULATED correct state, so the
           rest of the app (Snellen, Near, Contrast, Diopter, results,
           etc.) can be tested without being blocked by this one piece.
           No "cover your eye" alert will fire while this is active.

           TO RE-ENABLE: delete this bypass block (down to the matching
           END TEMP BYPASS marker) and remove the /- * -/ comment markers
           (no dashes, written apart here only so this note doesn't
           close its own comment) around the original logic below it —
           nothing else changes.
           ══════════════════════════════════════════════════════════════ */
        const lo = S.currentEye !== 'OD';   // OD test → left eye should be covered → simulated lo=false
        const ro = S.currentEye !== 'OS';   // OS test → right eye should be covered → simulated ro=false
        S.bothEyesOpen = lo && ro;
        { const pv=$('pv-overlay'); if(pv) pv.style.display='none'; S._pvActive=false; }
        if($('s-cover-status')){ $('s-cover-status').textContent='(cover-check disabled)'; $('s-cover-status').style.color='var(--white-dim)'; }
        if($('pv-blink-status')) $('pv-blink-status').textContent='Eye detection: disabled (dev bypass — ML in training)';
        /* ══ END TEMP BYPASS ═══════════════════════════════════════════ */

        /* ── ORIGINAL DETECTION LOGIC (commented out — not deleted) ──────
        function calcEAR(topIdxs, botIdxs, hlIdx, hrIdx){
            const vTop=topIdxs.reduce((s,i)=>s+lm[i].y,0)/topIdxs.length;
            const vBot=botIdxs.reduce((s,i)=>s+lm[i].y,0)/botIdxs.length;
            const vAp=Math.abs(vTop-vBot)*H;
            const hW=Math.abs(lm[hlIdx].x-lm[hrIdx].x)*W;
            return hW>0?vAp/hW:0;
        }
        const lEAR=calcEAR(L_EAR_TOP,L_EAR_BOT,L_EYE_H_L,L_EYE_H_R);
        const rEAR=calcEAR(R_EAR_TOP,R_EAR_BOT,R_EYE_H_L,R_EYE_H_R);

        if(!S._earState) S._earState={lLowSince:0,rLowSince:0,lo:true,ro:true};
        const now=Date.now();
        const EAR_OPEN=0.18,EAR_COVER=0.11,COVER_SUSTAIN=550;

        if(lEAR<EAR_COVER){if(!S._earState.lLowSince)S._earState.lLowSince=now;}
        else{S._earState.lLowSince=0;}
        if(rEAR<EAR_COVER){if(!S._earState.rLowSince)S._earState.rLowSince=now;}
        else{S._earState.rLowSince=0;}

        const lo = !(lEAR<EAR_COVER && S._earState.lLowSince>0 && now-S._earState.lLowSince>=COVER_SUSTAIN);
        const ro = !(rEAR<EAR_COVER && S._earState.rLowSince>0 && now-S._earState.rLowSince>=COVER_SUSTAIN);
        S.bothEyesOpen=lo&&ro;

        if(!S._bs)S._bs={l:false,r:false,count:0,last:0};
        const bs=S._bs;
        if((lEAR<EAR_COVER||rEAR<EAR_COVER)&&!bs.l&&!bs.r){bs.l=lEAR<EAR_COVER;bs.r=rEAR<EAR_COVER}
        else if(lEAR>=EAR_OPEN&&rEAR>=EAR_OPEN&&(bs.l||bs.r)){if(now-bs.last>180){bs.count++;bs.last=now}bs.l=false;bs.r=false}
        const pvBlink=$('pv-blink-status');if(pvBlink)pvBlink.textContent=`Blinks: ${bs.count}  ·  L:${lEAR.toFixed(2)} R:${rEAR.toFixed(2)} (cover<${EAR_COVER})`;

        const coverGated=['snellen'];
        if(coverGated.includes(S.screen)){
            const coverOk=S.currentEye==='OD'
                ?(lEAR<EAR_COVER&&S._earState.lLowSince>0&&now-S._earState.lLowSince>=COVER_SUSTAIN)
                :(rEAR<EAR_COVER&&S._earState.rLowSince>0&&now-S._earState.rLowSince>=COVER_SUSTAIN);
            const pv=$('pv-overlay');
            if(!coverOk&&lo&&ro){
                if(!S._pvTimer)S._pvTimer=setTimeout(()=>{
                    S._pvTimer=null;if(!S._pvSus)return;
                    if(pv)pv.style.display='flex';
                    if($('pv-eye-name'))$('pv-eye-name').textContent=S.currentEye==='OD'?'your left eye':'your right eye';
                    ['opto-stage','near-canvas','near-stage'].forEach(id=>{const e=$(id);if(e)e.style.visibility='hidden'});
                    S._pvActive=true;
                },1800);
                S._pvSus=true;
            } else {
                S._pvSus=false;
                if(S._pvTimer){clearTimeout(S._pvTimer);S._pvTimer=null}
                if(pv)pv.style.display='none';
                ['opto-stage','near-canvas','near-stage'].forEach(id=>{const e=$(id);if(e)e.style.visibility='visible'});
                S._pvActive=false;
            }
            if(S.screen==='snellen'&&$('s-cover-status')){$('s-cover-status').textContent=coverOk?'✓ Covered':'COVER EYE';$('s-cover-status').style.color=coverOk?'var(--green)':'var(--red)'}
        } else {const pv=$('pv-overlay');if(pv)pv.style.display='none';S._pvActive=false}
        ──────────────────────────────────────────────────────────────── */
        drawFaceOverlay(lm,W,H);
        GESTUREALERT.tick(lm,lo,ro,S.distanceCm);
    }

    function drawFaceOverlay(lm,W,H){
        const canvas=S.screen==='setup'?$('face-canvas'):$('pip-canvas');if(!canvas)return;
        const pip=S.screen!=='setup',vEl=pip?$('pip-video'):$('setup-video');
        // PERF-05: Match canvas resolution exactly to its CSS display size
        const cssW=pip?156:(vEl.clientWidth||400);
        const cssH=pip?110:(vEl.clientHeight||300);
        if(canvas.width!==cssW){canvas.width=cssW;canvas.height=cssH;canvas.style.width=cssW+'px';canvas.style.height=cssH+'px';}
        const sw=canvas.width,sh=canvas.height,ctx=canvas.getContext('2d');
        ctx.clearRect(0,0,cssW,cssH);
        [LEFT_IRIS,RIGHT_IRIS].forEach(iris=>{
            const c=lm[iris[0]],e=lm[iris[1]],r=Math.abs((e.x-c.x)*cssW)||6;
            ctx.beginPath();ctx.arc(c.x*cssW,c.y*cssH,r,0,Math.PI*2);
            ctx.strokeStyle='rgba(26,86,219,.85)';ctx.lineWidth=1.5;ctx.stroke();
            ctx.beginPath();ctx.arc(c.x*cssW,c.y*cssH,2,0,Math.PI*2);
            ctx.fillStyle='rgba(0,212,255,1)';ctx.fill()
        });
    }

    function updateHUDLabels(irisPx,dist){
        // FIX 23: round to nearest 5cm to stop implying false precision
        const distRounded = Math.round(dist/5)*5;
        if($('hud-iris'))$('hud-iris').textContent=`IRIS: ${irisPx.toFixed(1)}px`;
        if($('hud-dist-px'))$('hud-dist-px').textContent=`DIST: ~${distRounded} cm (est.)`;
        if($('hud-conf'))$('hud-conf').textContent=`CONF: ${irisPx>8?'HIGH':irisPx>5?'MED':'LOW'}`;
        if($('nav-dist-pill'))$('nav-dist-pill').textContent=`~${distRounded} cm`;
    }

    function updateDistUI(d){
        const noData=d==null,val=noData?'— cm':d.toFixed(1)+' cm';
        if($('dist-val'))$('dist-val').textContent=val;
        if($('pip-dist-text'))$('pip-dist-text').textContent=noData?'Measuring…':'Distance: '+val;
        if($('sstat-dist'))$('sstat-dist').textContent=noData?'—':d.toFixed(0)+' cm';
        // Update PIP overlay badge
        const overlay=$('pip-dist-overlay');
        if(overlay){overlay.textContent=val;overlay.style.display=noData?'none':'block'}
        if(noData){setCheck('chk-iris','','⏳','—');_setPIPStatus('measuring','Measuring…','#E2E8F0');return}
        setCheck('chk-iris','pass','✓',d.toFixed(0)+' cm');
        const ok=d>=40&&d<=70;
        setCheck('chk-dist',ok?'pass':'warn',ok?'✓':'⚠',d.toFixed(0)+' cm');
        const pct=Math.max(2,Math.min(98,(d-25)/60*100));
        if($('dist-fill')){$('dist-fill').style.width=pct+'%';$('dist-fill').style.background=ok?'#059669':d<40?'#D97706':'#DC2626'}
        if($('dist-pointer'))$('dist-pointer').style.left=pct+'%';
        const pp=Math.max(5,Math.min(95,pct));
        if($('pip-dist-fill')){
            $('pip-dist-fill').style.width=pp+'%';
            $('pip-dist-fill').style.background=ok?'#059669':d<40?'#D97706':'#DC2626';
        }
        _setPIPStatus(ok?'good':'warn', ok?'Face detected':'Adjust distance', ok?'#059669':'#D97706');
        // Update face guide ellipse colour
        const ellipse=$('pip-guide-ellipse');
        if(ellipse) ellipse.style.stroke=ok?'rgba(5,150,105,.6)':'rgba(217,119,6,.6)';
    }

    function _setPIPStatus(state, label, color){
        const dot=$('pip-status-dot');
        const lbl=$('pip-status-label');
        if(dot) dot.style.background=color;
        if(lbl){ lbl.textContent=label; lbl.style.color=color; }
    }

    /* ── CAMERA ──────────────────────────────────────────────────── */
    // FIX 12: apply transform:scale on opto-row — GPU composited, no layout reflow
    let _snellenResizeTimer=null;
    let _snellenBasePxH=null;  // px height when question was first rendered
    let _snellenBaseDist=null; // distance (cm) when question was first rendered
    function _debouncedSnellenResize(basePxH, currentDistCm){
        clearTimeout(_snellenResizeTimer);
        _snellenResizeTimer=setTimeout(()=>{
            const row=document.getElementById('opto-row');
            if(!row||!_snellenBasePxH||!_snellenBaseDist)return;
            // Scale letters so they subtend the same visual angle as the user moves.
            // ratio = currentDist/baseDist: user farther → letters grow; user closer → letters shrink.
            const ratio=Math.max(0.5,Math.min(2.5,currentDistCm/_snellenBaseDist));
            row.style.transform=`scale(${ratio})`;
            row.style.transformOrigin='center center';
            // Update nav pill to show live scale factor
            const pill=$('nav-font-pill');
            if(pill){
                if(ratio<0.97||ratio>1.03){
                    pill.textContent=`×${ratio.toFixed(2)}`;
                    pill.style.display='block';
                } else {
                    pill.style.display='none';
                }
            }
        },100);
    }

    async function startCamera(){
        const isMobile=/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
        // Try ideal constraints first, fall back to minimal for older mobile cameras
        const constraints=[
            {video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false},
            {video:{facingMode:'user',width:{ideal:320},height:{ideal:240}},audio:false},
            {video:{facingMode:'user'},audio:false},
            {video:true,audio:false},
        ];
        let stream=null;
        try{
            for(const c of constraints){
                try{stream=await navigator.mediaDevices.getUserMedia(c);break}
                catch(e){if(e.name==='NotAllowedError')throw e}  // permission denied — stop trying
            }
            if(!stream)throw new Error('No camera available');
        }catch(e){
            // Genuine permission denial or no camera hardware — this is the ONLY
            // place "Camera denied" is a correct diagnosis.
            setCheck('chk-cam','fail','✗','Denied');toast('Camera denied — manual mode.');skipCamera();return;
        }
        S.stream=stream;S.cameraOk=true;[$('setup-video'),$('pip-video')].forEach(v=>{if(v){v.srcObject=stream;v.play().catch(()=>{})}});setCheck('chk-cam','pass','✓','Granted');if($('cam-hud-text'))$('cam-hud-text').textContent='CAMERA ACTIVE';
        if($('pip')){ $('pip').style.display='flex'; _setPIPStatus('measuring','Face detection active','#1A56DB'); }
        if($('nav-dist-pill'))$('nav-dist-pill').style.display='block';
        // Camera permission is now definitively granted — everything below this
        // line is MediaPipe SETUP, not permission handling. A failure here must
        // NEVER be treated as "camera denied" (that would undo cameraOk=true and
        // freeze distance at a hardcoded fallback while the preview still looks live).
        try{
            if(!S.mpReady && window._loadMediaPipe){
                try{ await window._loadMediaPipe(); await initMediaPipe(); }
                catch(e){ S.mpReady=false; }
            }
            if(S.mpReady){
                // FIX: do NOT use MediaPipe's Camera utility here — Camera.start()
                // internally calls getUserMedia AGAIN for a brand-new stream, which
                // races against the stream we already acquired above and can throw
                // NotReadableError ("camera already in use") on many devices. Instead,
                // pump frames from the video element we already have a working stream
                // attached to — no second camera acquisition, no race.
                const vid=$('setup-video');
                let pumping=true,sendFails=0; S._mpStopPump=()=>{pumping=false};
                S._mpGotResult=false;
                setTimeout(()=>{if(pumping&&!S._mpGotResult)toast('📷 Face tracker is still loading. On a slow connection you can set your distance manually.',6000)},25000);
                (function pump(){
                    if(!pumping)return;
                    if(vid.readyState>=2 && S.mpFaceMesh){
                        S.mpFaceMesh.send({image:vid}).then(()=>{sendFails=0}).catch(()=>{sendFails++}).finally(()=>{
                            if(!pumping)return;
                            if(sendFails>=15){
                                pumping=false;S.mpReady=false;
                                toast('📷 Face tracker could not start. Enter your distance manually.',6000);
                                startFallback();
                                return;
                            }
                            requestAnimationFrame(pump);
                        });
                    } else {
                        requestAnimationFrame(pump);
                    }
                })();
            }else{startFallback()}
        }catch(e){ startFallback(); }
        setTimeout(()=>_afterCameraSetup(),350);
    }
    // BUGFIX: this used to unconditionally call goCalib(), which meant
    // resuming a saved session (where calibration is already done) still
    // got yanked back to the calibration screen the moment camera setup
    // finished — even though the resume banner may have already routed
    // to the correct in-progress test. Route based on actual state instead.
    function _afterCameraSetup(){
        if(S.calibDone){ advanceSequence(); }
        else{ goCalib(); }
    }
    let _fb=null;
    function startFallback(){
        if(_fb)clearInterval(_fb);
        const vid=$('setup-video'),canvas=$('face-canvas'),ctx=canvas.getContext('2d');
        _fb=setInterval(()=>{
            if(S.mpReady){clearInterval(_fb);_fb=null;return;} // MP loaded — yield
            if(!vid.videoWidth)return;
            canvas.width=vid.videoWidth;canvas.height=vid.videoHeight;ctx.drawImage(vid,0,0);
            const fr=ctx.getImageData(0,0,canvas.width,canvas.height);let sk=0;
            for(let i=0;i<fr.data.length;i+=16){const r=fr.data[i],g=fr.data[i+1],b=fr.data[i+2];if(r>95&&g>40&&b>20&&r>g&&r>b&&Math.abs(r-g)>15)sk++}
            const ratio=sk/(fr.data.length/16);
            if(ratio>.02){const d=Math.max(28,Math.min(100,Math.round(88-ratio*600)));S.distanceCm=d;S._lastDistUpdate=Date.now();updateDistUI(d)}
            ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='rgba(0,212,255,.6)';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(canvas.width/2,canvas.height/2,canvas.width*.22,canvas.height*.32,0,0,Math.PI*2);ctx.stroke()
        },300);
    }
    function skipCamera(){S.cameraOk=false;S.distanceCm=60;updateDistUI(60);setCheck('chk-cam','fail','—','Skipped');setCheck('chk-iris','fail','—','Manual');_afterCameraSetup()}
    if($('manual-slider'))$('manual-slider').addEventListener('input',function(){S.distanceCm=parseInt(this.value);if($('manual-val'))$('manual-val').textContent=this.value+' cm';updateDistUI(S.distanceCm)});


    /* ── EYE SELECTION ──────────────────────────────────────────── */
    function selectEye(eye){S.currentEye=eye;S._earState=null;updateEyePill();GESTUREALERT.onEyeSelected(eye)}
    function updateEyePill(){const p=$('nav-eye-pill');if(!p)return;p.style.display='block';p.textContent=S.currentEye==='OD'?'RIGHT EYE':'LEFT EYE';p.style.background=S.currentEye==='OD'?'rgba(0,212,255,.12)':'rgba(0,230,118,.12)';p.style.color=S.currentEye==='OD'?'var(--cyan)':'var(--green)';p.style.border=S.currentEye==='OD'?'1px solid rgba(0,212,255,.3)':'1px solid rgba(0,230,118,.3)'}

    /* ══ SNELLEN ═════════════════════════════════════════════════ */
    let _currentSnellenQ = null;  // display params only from server

    async function startSnellen(){
        showScreen('snellen');GESTUREALERT.onTestStart('snellen',S.currentEye);setProgress(S.currentEye==='OD'?2:22);
        renderSnellenEyeHeader();
        // BUGFIX-FREEZE: wipe old question immediately so the screen never shows
        // stale letters/buttons during the API round-trip. Previously the old
        // content stayed fully visible and tappable for syncSession + snellen/start
        // (up to 3s on a slow connection), which looked like a hard freeze.
        const row=$('opto-row');
        if(row)row.innerHTML='<div style="opacity:.35;font-size:13px;font-family:\'DM Sans\',sans-serif;color:#94A3B8;text-align:center;padding:24px 0">Loading…</div>';
        const grid=$('choice-grid');if(grid)grid.innerHTML='';
        const crBtn=$('cant-read-btn');if(crBtn)crBtn.disabled=true;
        try {
            // FIX: NOT redundant — calibPPMM/calibDone are only sent to the server by syncSession() (the session is
            // created BEFORE calibration). Fire-and-forget raced snellen/start (letter size fell back to 96 DPI), and
            // with Redis the late write could overwrite the new question. Await it; failure stays non-fatal.
            try{await syncSession()}catch(e){console.warn('[OcuScan] syncSession failed (non-fatal):',e.message)}
            const data = await api('/api/snellen/start',{eye:S.currentEye,distanceCm:S.distanceCm});
            if(!data.ok)throw new Error(data.error);
            renderSnellenQuestion(data.question);
            if(crBtn)crBtn.disabled=false;
            TTS.say((S.currentEye==='OD'?'Eye chart test. ':'')+_eyeLead()+' Tap the letter you see.',true);
        } catch(e){
            if(crBtn)crBtn.disabled=false;
            _testError('snellen',e);
        }
    }

    function renderSnellenEyeHeader(){
        updateEyePill();
        if($('s-eye-label')){$('s-eye-label').textContent=S.currentEye==='OD'?'RIGHT EYE (OD)':'LEFT EYE (OS)';$('s-eye-label').style.color=S.currentEye==='OD'?'var(--amber)':'var(--green)'}
        if($('s-reminder-text'))$('s-reminder-text').textContent=S.currentEye==='OD'?'Cover your LEFT eye — it appears on the LEFT side of the screen.':'Cover your RIGHT eye — it appears on the RIGHT side of the screen.';
    }

    function renderSnellenQuestion(q){
        _currentSnellenQ = q;
        _snellenBasePxH  = q.pxH;
        _snellenBaseDist = S.distanceCm || 60; // anchor distance for live scaling
        if($('s-level-label'))$('s-level-label').textContent=`Level ${q.level+1}/7 — ${q.label}`;
        if($('sstat-level'))$('sstat-level').textContent=`${q.level+1}/7`;
        if($('sstat-snellen'))$('sstat-snellen').textContent=q.label;
        if($('sstat-logmar'))$('sstat-logmar').textContent=q.logMAR.toFixed(2);
        if($('sstat-dist'))$('sstat-dist').textContent=S.distanceCm?S.distanceCm.toFixed(0)+' cm':'— cm';
        if($('s-angle-note'))$('s-angle-note').textContent=q.arcMin+' arc-min';
        if($('opto-stage'))$('opto-stage').style.minHeight=(q.pxH+56)+'px';
        const row=$('opto-row');row.innerHTML='';
        q.letters.forEach(l=>{const s=document.createElement('span');s.className='opto-letter';s.textContent=l;s.style.fontSize=q.pxH+'px';s.style.lineHeight='1';row.appendChild(s)});
        // ANIM-03: blur-to-sharp reveal — reinforces the "vision test" metaphor
        if (window._animSnellenLetter) {
            row.querySelectorAll('.opto-letter').forEach((el, i) => {
                setTimeout(() => window._animSnellenLetter(el), i * 55);
            });
        } else {
            gsap.from('.opto-letter',{opacity:0,scale:.85,duration:.3,stagger:.06,ease:'back.out(1.7)'});
        }
        buildSnellenChoices(q.choices);
        setProgress((S.currentEye==='OD'?2:22)+(q.level/7)*18);S._snellenFails=0;
    }

    function buildSnellenChoices(choices){
        const grid=$('choice-grid');grid.innerHTML='';
        choices.forEach(l=>{const b=document.createElement('button');b.className='choice-btn';b.textContent=l;b.setAttribute('aria-label','Letter option: '+l);b.onclick=()=>snellenAnswer(l,b);grid.appendChild(b)});
    }

    async function snellenAnswer(letter, btnEl){
        const _btns=[...document.querySelectorAll('.choice-btn')];
        _btns.forEach(b=>{b.onclick=null;b.disabled=true});
        gsap.from(btnEl,{scale:1.1,duration:.2,ease:'power2.out'});
        try {
            const data=await api('/api/snellen/answer',{userAnswer:letter,distanceCm:S.distanceCm});
            if(!data.ok)throw new Error(data.error);
            btnEl.classList.add(data.wasCorrect?'correct':'wrong');
            setTimeout(()=>{
                if(data.action==='finish'){
                    handleSnellenFinish(data.result);
                } else {
                    renderSnellenQuestion(data.question);
                }
            },700);
        } catch(e){
            // BUGFIX-FREEZE: re-enable choice buttons on failure, otherwise the
            // test is stuck forever (all buttons disabled, onclick removed) and
            // the only way out was a full page refresh.
            toast('⚠ Server error: '+e.message+' — tap a letter to retry');
            _btns.forEach(b=>{b.disabled=false;b.onclick=()=>snellenAnswer(b.textContent,b)});
        }
    }

    function cantRead(){
        const _btns=[...document.querySelectorAll('.choice-btn')];
        _btns.forEach(b=>{b.onclick=null;b.disabled=true});
        const crBtn=$('cant-read-btn');if(crBtn)crBtn.disabled=true;
        api('/api/snellen/cantread',{})
            .then(d=>{
                if(!d.ok)throw new Error(d.error||'Server error');
                if(d.action==='finish')handleSnellenFinish(d.result);
            })
            .catch(e=>{
                toast('⚠ '+e.message+' — tap Cannot Read to retry');
                _btns.forEach(b=>{b.disabled=false;b.onclick=()=>snellenAnswer(b.textContent,b)});
                if(crBtn)crBtn.disabled=false;
            });
    }

    function handleSnellenFinish(result){
        S.completed['snellen-'+S.currentEye]=true;
        _snellenBaseDist=null; _snellenBasePxH=null;
        const pill=$('nav-font-pill');if(pill)pill.style.display='none';
        const row=$('opto-row');if(row){row.innerHTML='';row.style.transform='';}
        const grid=$('choice-grid');if(grid)grid.innerHTML='';
        // Hide pv-overlay and cancel its timer — otherwise it bleeds onto the next test
        const pv=$('pv-overlay');if(pv)pv.style.display='none';
        S._pvActive=false;S._pvSus=false;
        if(S._pvTimer){clearTimeout(S._pvTimer);S._pvTimer=null;}
        ['opto-stage','near-canvas','near-stage'].forEach(id=>{const e=$(id);if(e)e.style.visibility='visible'});
        PWA._maybeShow?.();_saveProgress();
        const snellenDone = S.completed['snellen-OD'] && S.completed['snellen-OS'];
        if(!snellenDone){
            const next=S.currentEye==='OD'?'OS':'OD';
            toast(`${S.currentEye} complete (${result.label}). Now test ${next} eye.`,4000);
            setProgress(20);setTimeout(()=>advanceSequence(),600); // was 1500ms — now 600ms, content already cleared
            return;
        }
        S.completed['snellen']=true;
        setProgress(40);toast('Visual acuity complete!');setTimeout(()=>advanceSequence(),500); // was 900ms
    }

    /* ══ NEAR VISION ═════════════════════════════════════════════ */
    let _nearQ=null;
    let _nearResizeTimer=null;

    async function startNear(){
        showScreen('near');GESTUREALERT.onTestStart('near',S.currentEye);if($('prog-wrap'))$('prog-wrap').style.display='block';setProgress(S.currentEye==='OD'?40:50);
        renderNearEyeHeader();
        _nearQ=null;
        document.querySelectorAll('.near-gap-btn').forEach(b=>{b.disabled=true;b.style.opacity='0.4'});
        try{
            try{await syncSession()}catch(e){console.warn('[OcuScan] syncSession failed (non-fatal):',e.message)}
            const data=await api('/api/near/start',{eye:S.currentEye,distanceCm:S.distanceCm,dpr:window.devicePixelRatio||1});
            if(!data.ok)throw new Error(data.error);
            renderNearQuestion(data);
            TTS.say(S.currentEye==='OD'?'Ring test. '+_eyeLead()+' Hold the screen about 40 centimetres away and tap the direction the gap faces. The ring gets smaller each time you get it right.':_eyeLead()+' Tap the direction the gap faces.',true)
        }
        catch(e){_testError('near',e)}
    }

    function renderNearEyeHeader(){
        updateEyePill();
        if($('near-eye-label')){$('near-eye-label').textContent=S.currentEye==='OD'?'RIGHT EYE (OD)':'LEFT EYE (OS)';$('near-eye-label').style.color=S.currentEye==='OD'?'var(--amber)':'var(--green)'}
        if($('near-reminder-text'))$('near-reminder-text').textContent=S.currentEye==='OD'?'Cover your LEFT eye.':'Cover your RIGHT eye.';
    }

    function renderNearQuestion(d){
        document.querySelectorAll('.near-gap-btn').forEach(b=>{b.disabled=false;b.style.opacity=''});
        if($('near-instruction'))$('near-instruction').textContent='Which direction is the gap opening?';
        if($('near-step-lbl'))$('near-step-lbl').textContent=`Level ${d.level+1} / ${d.total} — ${d.label}`;
        _nearQ={direction:d.direction,ringPx:d.ringPx,minPx:d.minPx,baseDist:d.baseDist||S.distanceCm||40};
        _paintNearRing();
        setProgress((S.currentEye==='OD'?40:50)+(d.level/d.total)*10);
    }

    function _nearScale(){
        if(!_nearQ)return 1;
        const dist=S.distanceCm||_nearQ.baseDist;
        return Math.max(0.5,Math.min(2.5,dist/_nearQ.baseDist));
    }

    function _paintNearRing(){
        if(!_nearQ)return;
        const ratio=_nearScale();
        drawLandoltC(_nearQ.direction,Math.max(_nearQ.minPx,_nearQ.ringPx*ratio));
        const pill=$('nav-font-pill');
        if(pill){
            if(ratio<0.97||ratio>1.03){pill.textContent=`×${ratio.toFixed(2)}`;pill.style.display='block'}
            else pill.style.display='none';
        }
    }

    function _debouncedNearResize(){
        clearTimeout(_nearResizeTimer);
        _nearResizeTimer=setTimeout(_paintNearRing,100);
    }

    function drawLandoltC(direction,ringPx){
        const canvas=$('near-canvas');if(!canvas)return;
        const ctx=canvas.getContext('2d');
        const dpr=window.devicePixelRatio||1;
        const cssW=canvas.clientWidth||280,cssH=canvas.clientHeight||180;
        if(canvas.width!==Math.round(cssW*dpr)||canvas.height!==Math.round(cssH*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);canvas.style.width=cssW+'px';canvas.style.height=cssH+'px';}
        ctx.setTransform(1,0,0,1,0,0);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.save();ctx.scale(dpr,dpr);
        ctx.fillStyle='#f5f5f5';ctx.fillRect(0,0,cssW,cssH);
        const D=Math.min(ringPx,Math.min(cssW,cssH)-12);
        const R=D/2,t=D/5,r=R-t;
        const angles={right:0,down:Math.PI/2,left:Math.PI,up:-Math.PI/2};
        ctx.translate(cssW/2,cssH/2);
        ctx.rotate(angles[direction]||0);
        ctx.fillStyle='#111';
        ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.moveTo(r,0);ctx.arc(0,0,r,0,Math.PI*2);ctx.fill('evenodd');
        ctx.fillStyle='#f5f5f5';
        ctx.fillRect(r-1,-t/2,R-r+2,t);
        ctx.restore();
    }

    async function nearAnswer(dir){
        const btns=[...document.querySelectorAll('.near-gap-btn')];
        btns.forEach(b=>b.disabled=true);
        gsap.to('#near-canvas',{scale:.95,duration:.08,yoyo:true,repeat:1});
        try{
            const data=await api('/api/near/answer',{userAnswer:dir,distanceCm:S.distanceCm,dpr:window.devicePixelRatio||1});
            if(!data.ok)throw new Error(data.error);
            if(data.action==='next'){
                renderNearQuestion(data);
                btns.forEach(b=>b.disabled=false);
            } else {
                // action:'finish'
                S.completed['near-'+S.currentEye]=true;
                _nearQ=null;clearTimeout(_nearResizeTimer);
                const fp=$('nav-font-pill');if(fp)fp.style.display='none';
                PWA._maybeShow?.();_saveProgress();
                // Clear canvas + disable buttons immediately — no frozen Landolt C for 900ms
                const nc=$('near-canvas');if(nc){const ctx=nc.getContext('2d');ctx.clearRect(0,0,nc.width,nc.height);}
                btns.forEach(b=>{b.disabled=true;b.style.opacity='0.4';});
                const nl=$('near-instruction');if(nl)nl.textContent='Analysing results…';
                const nearDone = S.completed['near-OD'] && S.completed['near-OS'];
                if(!nearDone){
                    const next=S.currentEye==='OD'?'OS':'OD';
                    toast(`${S.currentEye} complete (${data.result.label}). Now test ${next} eye.`,4000);
                    setProgress(50);setTimeout(()=>advanceSequence(),600);
                    return;
                }
                S.completed['near']=true;
                toast(`Near vision complete!`);setProgress(60);
                setTimeout(()=>advanceSequence(),900);
            }
        }catch(e){
            btns.forEach(b=>b.disabled=false);
            _testError('near',e);
        }
    }

    /* ══ DIOPTER ═════════════════════════════════════════════════ */
    const DIOP={
        phase:1,_canvasInterval:null,_inFlight:false,
        async start(){S.diopterPhase=1;DIOP.phase=1;DIOP._inFlight=false;showScreen('diopter');setProgress(S.currentEye==='OD'?70:85);DIOP._setUI();DIOP._startCanvas();DIOP._renderEyeHeader();TTS.say(S.currentEye==='OD'?'Blur test. '+_eyeLead()+' Start close, then slowly move away until the pattern blurs. Tap the button when it does.':_eyeLead()+' Start close, move away until it blurs, then tap the button.',true);try{await api('/api/diopter/start',{eye:S.currentEye})}catch(e){/* non-fatal — blur/cantblur will surface a real error if the session is actually broken */}},
        _renderEyeHeader(){
            updateEyePill();
            if($('diop-eye-label')){$('diop-eye-label').textContent=S.currentEye==='OD'?'RIGHT EYE (OD)':'LEFT EYE (OS)';$('diop-eye-label').style.color=S.currentEye==='OD'?'var(--amber)':'var(--green)'}
            if($('diop-reminder-text'))$('diop-reminder-text').textContent=S.currentEye==='OD'?'Cover your LEFT eye.':'Cover your RIGHT eye.';
        },
        _setUI(){if(DIOP.phase===1){if($('diop-phase-label'))$('diop-phase-label').textContent='Phase 1 of 2';if($('diop-phase-title'))$('diop-phase-title').textContent='PHASE 1 — FAR POINT TEST';if($('diop-instruction'))$('diop-instruction').textContent='Start CLOSE. Move AWAY until the pattern blurs.';if($('diop-blur-btn')){$('diop-blur-btn').textContent="🔵 It's Blurring Now";$('diop-blur-btn').style.display='block';$('diop-blur-btn').disabled=false}if($('diop-result-box'))$('diop-result-box').style.display='none'}else{if($('diop-phase-label'))$('diop-phase-label').textContent='Phase 2 of 2';if($('diop-phase-title'))$('diop-phase-title').textContent='PHASE 2 — NEAR POINT CHECK';if($('diop-instruction'))$('diop-instruction').textContent='Move screen CLOSE until blurs.';if($('diop-blur-btn')){$('diop-blur-btn').textContent="🔵 It's Blurring Now";$('diop-blur-btn').style.display='block';$('diop-blur-btn').disabled=false}if($('diop-result-box'))$('diop-result-box').style.display='none'}},
        _startCanvas(){clearInterval(DIOP._canvasInterval);DIOP._canvasInterval=setInterval(()=>DIOP._draw(),100)},
        _draw(){const canvas=$('diop-canvas');if(!canvas)return;const ctx=canvas.getContext('2d');
        const dpr=window.devicePixelRatio||1;
        const cssW=canvas.clientWidth||280,cssH=canvas.clientHeight||150;
        if(canvas.width!==Math.round(cssW*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);canvas.style.width=cssW+'px';canvas.style.height=cssH+'px';}
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.save();ctx.scale(dpr,dpr);
        ctx.fillStyle='#f5f5f5';ctx.fillRect(0,0,cssW,cssH);
        const ppmm=S.calibPPMM||3.78,r=Math.max(14,(3.5*ppmm)/2);
        const dirs=['up','right','down','left'];
        const cols=3,rows=2,padX=cssW/(cols+1),padY=cssH/(rows+1);
        Array.from({length:6}).forEach((_,i)=>{const cx=padX*(1+(i%cols)),cy=padY*(1+Math.floor(i/cols));const dA={right:0,down:Math.PI/2,left:Math.PI,up:-Math.PI/2}[dirs[i%4]],gA=Math.PI/5;ctx.beginPath();ctx.arc(cx,cy,r,dA+gA/2,dA-gA/2+Math.PI*2);ctx.strokeStyle='#111';ctx.lineWidth=Math.max(2,r/5);ctx.lineCap='round';ctx.stroke()});
        const d=S.distanceCm||0;if($('diop-dist-val'))$('diop-dist-val').textContent=d?d.toFixed(0)+' cm':'— cm';if($('diop-dist-fill'))$('diop-dist-fill').style.width=Math.min(100,(d/100)*100)+'%';
        ctx.restore();},
        async blurNow(){
            if(DIOP._inFlight)return;
            const d=S.distanceCm;
            const liveTrackingStale = S.cameraOk && S.mpReady && (Date.now()-(S._lastDistUpdate||0)>3000);
            if(!d||d<20||liveTrackingStale){toast('⚠ Distance not detected — move in front of camera');return}
            DIOP._inFlight=true;
            const btn=$('diop-blur-btn');if(btn)btn.disabled=true;
            try{const data=await api('/api/diopter/blur',{phase:DIOP.phase,distanceCm:d});if(!data.ok)throw new Error(data.error);
            if(data.action==='phase2'){toast(`Far point: ${d.toFixed(1)} cm`);DIOP.phase=2;DIOP._setUI();setProgress(S.currentEye==='OD'?77:92);TTS.say('Now bring the screen close until it blurs again, then tap.',true)}
            else{clearInterval(DIOP._canvasInterval);DIOP._showResult(data.result)}}
            catch(e){toast('⚠ '+e.message)}
            finally{DIOP._inFlight=false;if(btn&&btn.style.display!=='none')btn.disabled=false;}
        },
        async cantBlur(){
            if(DIOP._inFlight)return;
            DIOP._inFlight=true;
            const btn=$('diop-blur-btn');if(btn)btn.disabled=true;
            try{const data=await api('/api/diopter/cantblur',{phase:DIOP.phase});if(!data.ok)throw new Error(data.error);
            if(data.action==='phase2'){toast('No far blur — likely emmetrope');DIOP.phase=2;DIOP._setUI();setProgress(S.currentEye==='OD'?77:92);TTS.say('Now bring the screen close until it blurs again, then tap.',true)}
            else{clearInterval(DIOP._canvasInterval);DIOP._showResult(data.result)}}
            catch(e){toast('⚠ '+e.message)}
            finally{DIOP._inFlight=false;if(btn&&btn.style.display!=='none')btn.disabled=false;}
        },
        _showResult(d){
            S.completed['diopter-'+S.currentEye]=true;
            PWA._maybeShow?.();_saveProgress();
            clearInterval(DIOP._canvasInterval);DIOP._canvasInterval=null;
            if($('diop-blur-btn'))$('diop-blur-btn').style.display='none';
            const rb=$('diop-result-box');if(rb)rb.style.display='block';
            const col=d.power<-6?'var(--red)':d.power<-.5?'var(--amber)':'var(--green)';
            if($('diop-power-val')){$('diop-power-val').textContent=d.power===0?'Plano':(d.power>0?'+':'')+d.power.toFixed(2);$('diop-power-val').style.color=col}
            if($('diop-category')){$('diop-category').textContent=d.category;$('diop-category').style.color=col}
            if($('diop-note'))$('diop-note').textContent=d.note;
            gsap.from('#diop-result-box',{scale:.9,opacity:0,duration:.4,ease:'back.out(1.7)'});
            // BUGFIX: the old 3.5s silent pause here read as "the app is stuck" —
            // shortened, and now shows an explicit status line so the wait is
            // visibly intentional instead of an unexplained freeze.
            let statusEl=$('diop-advance-status');
            if(!statusEl&&rb){statusEl=document.createElement('div');statusEl.id='diop-advance-status';statusEl.style.cssText='margin-top:14px;font-family:\'Space Mono\',monospace;font-size:12px;color:var(--white-dim);letter-spacing:.05em';rb.appendChild(statusEl);}
            const diopterDone = S.completed['diopter-OD'] && S.completed['diopter-OS'];
            if(!diopterDone){
                const next=S.currentEye==='OD'?'OS':'OD';
                toast(`${S.currentEye} complete. Now test ${next} eye.`,3000);
                if(statusEl)statusEl.textContent=`Switching to ${next==='OD'?'right':'left'} eye…`;
                setProgress(85);setTimeout(()=>advanceSequence(),2000);
                return;
            }
            S.completed['diopter']=true;
            if(statusEl)statusEl.textContent='Preparing your results…';
            setProgress(100);setTimeout(()=>advanceSequence(),2000);
        },
        stop(){clearInterval(DIOP._canvasInterval);DIOP._canvasInterval=null;DIOP._inFlight=false;}
    };

    /* ── Plain-language copy for the two power boxes ────────────────
       Thresholds mirror calcDiopter() on the server:
       ≥ −0.50 near normal · −0.50…−3 mild · −3…−6 moderate · below −6 high. */
    function _plainPower(d){
        const p = (d && typeof d.power==='number') ? d.power : null;
        if(p===null) return {num:'\u2014', state:'Not tested', line:"We didn't get a result for this eye. Take the tests again to see it.", tone:'none'};
        const a = Math.abs(p);
        const num = a===0 ? '0.00' : (p<0 ? '\u2212' : '+') + a.toFixed(2);
        if(p>=-0.5) return {num, state:'Looks sharp',            line:'Faraway things should look clear without glasses.', tone:'ok'};
        if(p>=-3)   return {num, state:'Slightly short-sighted', line:'Faraway things may look a little soft. Glasses can make them crisp.', tone:'mild'};
        if(p>=-6)   return {num, state:'Short-sighted',          line:'Faraway things look blurry without glasses.', tone:'mod'};
        return            {num, state:'Very short-sighted',       line:'Faraway things look very blurry without glasses. Please see an eye doctor soon.', tone:'high'};
    }
    function _paintEyeBox(eye, d){
        const box=$('rs-box-'+eye); if(!box) return;
        const t=_plainPower(d);
        $('rs-num-'+eye).textContent=t.num;
        $('rs-state-'+eye).textContent=t.state;
        $('rs-line-'+eye).textContent=t.line;
        box.dataset.tone=t.tone;
        box.classList.remove('is-loading');
        const spoken=t.num.replace('\u2212','minus ').replace('+','plus ');
        box.setAttribute('aria-label',(eye==='OD'?'Right':'Left')+' eye: '+spoken+'. '+t.state+'.');
    }
    function _paintResultsLoading(){
        ['OD','OS'].forEach(eye=>{
            const box=$('rs-box-'+eye); if(!box) return;
            box.classList.add('is-loading'); box.dataset.tone='none';
            $('rs-num-'+eye).textContent='\u2013.\u2013\u2013';
            $('rs-state-'+eye).textContent='Working it out\u2026';
            $('rs-line-'+eye).textContent='This takes a few seconds.';
        });
        const n=$('rs-note'); if(n) n.textContent='';
        const sc=$('rs-score'); if(sc){sc.classList.add('is-loading'); sc.dataset.tone='none'; $('rs-score-num').textContent='\u2013'; $('rs-score-verdict-text').textContent='Working it out\u2026'}
        _MINI.forEach(([key])=>_setMini(key,'\u2013','','none'));
    }
    function _paintResultsError(){
        ['OD','OS'].forEach(eye=>{
            const box=$('rs-box-'+eye); if(!box) return;
            box.classList.remove('is-loading'); box.dataset.tone='none';
            $('rs-num-'+eye).textContent='\u2014';
            $('rs-state-'+eye).textContent="We couldn't load this";
            $('rs-line-'+eye).textContent='Check your internet connection, then try again.';
        });
        const n=$('rs-note'); if(n) n.innerHTML='<button type="button" class="rs-retry" onclick="App.goResults()">Try again</button>';
        const sc=$('rs-score'); if(sc){sc.classList.remove('is-loading'); sc.dataset.tone='none'; $('rs-score-num').textContent='\u2014'; $('rs-score-verdict-text').textContent="We couldn't load this"}
        _MINI.forEach(([key])=>_setMini(key,'\u2014','','none'));
    }
    /* ── Final score + four small boxes ── */
    const _MINI=[['acuity','Visual Acuity'],['near','Near Vision'],['power','Diopter'],['contrast','Contrast Sensitivity']];
    const _TONE_OHI={green:'ok',amber:'mid',red:'low'};
    const _toneOfPct=p=>p>=80?'ok':p>=50?'mid':'low';
    function _setMini(key,val,cap,tone){
        const m=$('rs-mini-'+key); if(!m) return;
        m.dataset.tone=tone; m.querySelector('.rs-mini-val').textContent=val; m.querySelector('.rs-mini-cap').textContent=cap;
    }
    function _paintScore(data){
        const sc=$('rs-score'); if(!sc) return;
        const o=data.ohi;
        $('rs-score-num').textContent = o ? o.ohi : '\u2014';
        $('rs-score-verdict-text').textContent = o ? o.label : 'Not enough results yet';
        sc.dataset.tone = o ? (_TONE_OHI[o.color]||'none') : 'none';
        sc.classList.remove('is-loading');
        const tiles=data.scorecard||[], eyes=(data.diopterEyes||[]).filter(e=>typeof e.power==='number');
        _MINI.forEach(([key,name])=>{
            const t=tiles.find(x=>x.label===name);
            if(!t){_setMini(key,'\u2014','Not tested','none');return}
            let cap=t.val;
            if(key==='power'){const best=eyes.reduce((a,b)=>(a&&a.power>=b.power)?a:b,null); cap=best?_plainPower(best).state:''}
            _setMini(key,Math.round(t.pct)+'%',cap,_toneOfPct(t.pct));
        });
    }

    /* ══ RESULTS ═════════════════════════════════════════════════ */
    async function renderResults(){
        // Switch screens immediately and show a loading state, so a slow API call
        // (it retries up to 3x with backoff, ~7s) never leaves the user on the old screen.
        showScreen('results');
        _paintResultsLoading();
        try{
            const data=await api('/api/results/compute');if(!data.ok)throw new Error(data.error);
            const {ohi,scorecard}=data;
            const eyes=data.diopterEyes||[];
            ['OD','OS'].forEach(eye=>_paintEyeBox(eye, eyes.find(x=>x.eye===eye)));
            _paintScore(data);

            const _spoken=['OD','OS'].map(e=>{const t=_plainPower(eyes.find(x=>x.eye===e));return (e==='OD'?'Right':'Left')+' eye, '+(t.num==='\u2014'?'not tested':t.num.replace('\u2212','minus ').replace('+','plus '))}).join('. ');
            TTS.say('Your results are ready. '+_spoken+'.',true);
            showScreen('results'); setProgress(100); PWA._maybeShow?.();
            if (window._animResults) setTimeout(() => window._animResults(), 120);
            // Fire-and-forget anonymous research submission — no patientName stored
            fetch(RAILWAY_API_URL+'/api/research/submit',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({
                // Vision results — all anonymous numeric/categorical
                ohi:                ohi?.ohi||null,
                snellenOD:          data.powerEyes?.find(e=>e.eye==='OD')?.label||null,
                snellenOS:          data.powerEyes?.find(e=>e.eye==='OS')?.label||null,
                logMarOD:           data.powerEyes?.find(e=>e.eye==='OD')?.logMAR??null,
                logMarOS:           data.powerEyes?.find(e=>e.eye==='OS')?.logMAR??null,
                nearLabel:          scorecard?.find(t=>t.label==='Near Vision')?.val||null,
                diopterOD:          data.diopterEyes?.find(e=>e.eye==='OD')?.power??null, // FIX: powerEyes is the SNELLEN list (string range)
                diopterOS:          data.diopterEyes?.find(e=>e.eye==='OS')?.power??null,
                contrastScore:      data.contrastScore??null,
                // Context — no PII
                glasses:            data.glasses||S.glasses||null, // FIX: glasses lives on the server session; S.glasses is never set
                calibDone:          S.calibDone||false,
                distanceCm:         S.distanceCm||null,
              })
            }).catch(()=>{}); // silent
        }catch(e){console.error('[OcuScan] results error:',e);toast('\u26A0 Could not load results.');_paintResultsError();showScreen('results');setProgress(100)}
    }

    /* ══ PDF / CSV ═══════════════════════════════════════════════ */
    async function generatePDF(){
        if(generatePDF._busy)return;generatePDF._busy=true; // the footer link and the big button can both call this
        // The PDF is built by the server (/api/pdf); jsPDF was never used, and awaiting its CDN script could hang
        // this button forever on a network that silently drops the request — so it is no longer awaited.
        // FIX 21 — disable the button immediately to prevent double-tap. Target the big button by id (not "the first
        // element mentioning generatePDF") and change only its label, so its icon and sub-line survive.
        const pdfBtn = document.getElementById('res-pdf-btn') || document.querySelector('[onclick*="generatePDF"]');
        const pdfLbl = document.getElementById('res-pdf-label');
        const origText = pdfLbl ? pdfLbl.textContent : pdfBtn?.textContent;
        if(pdfBtn){pdfBtn.disabled=true;pdfBtn.setAttribute('aria-busy','true');if(pdfLbl)pdfLbl.textContent='Preparing your report…';else pdfBtn.textContent='⏳ Generating…';pdfBtn.style.opacity='.8';}
        toast('Generating your report…', 60000);
        try{
            const res=await fetch(RAILWAY_API_URL+'/api/pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:_sessionId,token:_sessionToken})});
            if(!res.ok){
                const err=await res.json().catch(()=>({error:'Server error'}));
                throw new Error(err.error||'PDF generation failed');
            }
            const blob=await res.blob();
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');a.href=url;a.download=`OcuScan_Report_${new Date().toISOString().slice(0,10)}.pdf`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove()},1000);
            toast('✓ PDF downloaded successfully');
        }
        catch(e){toast('⚠ Could not generate PDF — '+e.message,6000)}
        finally{
            generatePDF._busy=false;
            if(pdfBtn){pdfBtn.disabled=false;pdfBtn.removeAttribute('aria-busy');if(pdfLbl)pdfLbl.textContent=origText||'Download your report';else pdfBtn.textContent=origText||'Download PDF';pdfBtn.style.opacity='';}
        }
    }

    async function exportCSV(){
        try{const res=await fetch(RAILWAY_API_URL+'/api/csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:_sessionId,token:_sessionToken})});const blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`OcuScan_Research_${Date.now()}.csv`;a.click();URL.revokeObjectURL(url);toast('CSV downloaded ✓')}
        catch(e){toast('⚠ CSV failed')}
    }

    /* ══ PWA / CONSENT / ENV ══════════════════════════════════════ */
    const PWA={_dp:null,init(){window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();PWA._dp=e;PWA._maybeShow()});window.addEventListener('appinstalled',()=>{if($('install-bar'))$('install-bar').style.display='none';toast('✅ Installed!')})},_maybeShow(){let _d=false;try{_d=!!sessionStorage.getItem('pwa_dismissed')}catch(_){}if(_d||['snellen','near','contrast','diopter'].includes(S.screen))return;if(PWA._dp&&Object.keys(S.completed||{}).length>=1){const bar=$('install-bar');if(bar){bar.style.display='flex';gsap.fromTo(bar,{y:80,opacity:0},{y:0,opacity:1,duration:.4,ease:'power2.out'})}}},async install(){if(!PWA._dp)return;PWA._dp.prompt();const{outcome}=await PWA._dp.userChoice;if(outcome==='accepted')toast('Installing…');PWA._dp=null;if($('install-bar'))$('install-bar').style.display='none'},dismiss(){gsap.to('#install-bar',{y:80,opacity:0,duration:.3,onComplete:()=>{if($('install-bar'))$('install-bar').style.display='none'}});sessionStorage.setItem('pwa_dismissed','1')}};
    const CONSENT={
        _proceeded:false,
        proceed(){
            const s=$('consent-screen');
            if(!s)return;
            // Only fire the post-consent chain once, however many times proceed() runs
            const afterConsent=()=>{
                if(CONSENT._proceeded)return;
                CONSENT._proceeded=true;
                // Consent has now actually been given — THIS is what triggers the
                // camera-permission modal and the resume-session check. Nothing
                // camera- or session-related is queued up before this point.
                goSetup();
                _checkResume();
            };
            // Guard: if session not yet created, show error instead of proceeding silently
            if(!_sessionId){
                const btn=$('consent-proceed');
                if(btn){
                    const orig=btn.textContent;
                    btn.textContent='⏳ Connecting to server…';
                    btn.disabled=true;
                    // Retry session creation
                    createSession().then(()=>{
                        btn.disabled=false;
                        btn.textContent=orig;
                        // Now proceed
                        if(typeof gsap!=='undefined')gsap.to(s,{opacity:0,duration:.45,onComplete:()=>{s.style.display='none';afterConsent();}});
                        else{s.style.transition='opacity .45s';s.style.opacity='0';setTimeout(()=>{s.style.display='none';afterConsent();},460)}
                    }).catch(err=>{
                        btn.disabled=false;
                        btn.textContent='⚠ Server offline — tap to retry';
                        btn.style.background='#DC2626';
                        btn.onclick=()=>location.reload();
                    });
                }
                return;
            }
            if(typeof gsap!=='undefined')gsap.to(s,{opacity:0,duration:.45,onComplete:()=>{s.style.display='none';afterConsent();}});
            else{s.style.transition='opacity .45s';s.style.opacity='0';setTimeout(()=>{s.style.display='none';afterConsent();},460)}
        },
        // No init() skip — consent shown every session (A2)
        init(){}
    };
    const ENV={_pt:null,_checks:[],async run(t){ENV._pt=t;ENV._checks=[];await ENV._checkBattery();ENV._checkTilt();ENV._checks.push({icon:'☀️',label:'Screen Brightness',val:'Set to maximum',status:'warn',note:'Ensure 100% brightness.'});const f=ENV._checks.filter(c=>c.status==='fail'),w=ENV._checks.filter(c=>c.status==='warn');if(!f.length&&!w.length){ENV._launch();return}const c=$('env-checks');if(c)c.innerHTML=ENV._checks.map(ch=>`<div class="env-row"><div class="env-icon">${ch.icon}</div><div class="env-info"><div class="env-label">${ch.label}</div><div class="env-val">${ch.val}${ch.note?'<br><span style="color:var('+(ch.status==='fail'?'--red':'--amber')+')">'+ ch.note+'</span>':''}</div></div><div class="env-status">${ch.status==='ok'?'✅':ch.status==='warn'?'⚠️':'❌'}</div></div>`).join('');const m=$('env-modal');if(m){m.style.display='flex';gsap.fromTo('.env-inner',{y:24,opacity:0},{y:0,opacity:1,duration:.3,ease:'power2.out'})}},async _checkBattery(){if(!navigator.getBattery){ENV._checks.push({icon:'🔋',label:'Battery',val:'API unavailable',status:'ok'});return}try{const b=await navigator.getBattery();const pct=Math.round(b.level*100);ENV._checks.push({icon:'🔋',label:'Battery',val:`${pct}%`,status:pct<15?'fail':pct<30?'warn':'ok',note:pct<15?'Below 15%.':''})}catch(e){ENV._checks.push({icon:'🔋',label:'Battery',val:'OK',status:'ok'})}},_checkTilt(){if(!window._lastOrientation){ENV._checks.push({icon:'📐',label:'Device Tilt',val:'Sensor unavailable',status:'warn'});return}const{beta}=window._lastOrientation,diff=Math.abs((beta||0)-90);ENV._checks.push({icon:'📐',label:'Device Tilt',val:`${Math.round(beta||0)}°`,status:diff>30?'fail':diff>15?'warn':'ok',note:diff>30?'Too tilted.':''})},proceed(){if($('env-modal'))$('env-modal').style.display='none';ENV._launch()},cancel(){if($('env-modal'))$('env-modal').style.display='none';ENV._pt=null},_launch(){const t=ENV._pt;ENV._pt=null;if(t)App.startTest(t)}};
    window.addEventListener('deviceorientation',e=>{window._lastOrientation={alpha:e.alpha,beta:e.beta,gamma:e.gamma}},{once:false,passive:true});


    /* ══ NAVIGATION ══════════════════════════════════════════════ */
    /* ── PTQ: track if questionnaire has been shown this session ── */
    // FEATURE-10: Progress snapshot — save completed tests to localStorage
    // Answers stay server-side; only the completion map is cached client-side
    function _saveProgress() {
        if (!_sessionId) return;
        try {
            localStorage.setItem('ocu_progress', JSON.stringify({
                sessionId:  _sessionId,
                token:      _sessionToken,
                completed:  S.completed || {},
                patientName: S.patientName || '',
                calibPPMM:  S.calibPPMM  || null,
                calibDone:  S.calibDone  || false,
                currentEye: S.currentEye || 'OD',
                savedAt:    Date.now(),
            }));
        } catch(e) {}
    }

    function _checkResume() {
        try {
            const raw = localStorage.getItem('ocu_progress');
            if (!raw) return;
            const snap = JSON.parse(raw);
            // Only offer resume if < 3 hours old and has completed tests
            if (!snap.sessionId || !snap.completed) return;
            if (Date.now() - snap.savedAt > 3 * 60 * 60 * 1000) { localStorage.removeItem('ocu_progress'); return; }
            const count = Object.keys(snap.completed).length;
            if (count === 0) return;
            // Show resume banner (fixed-position, floats above whichever screen is active)
            const banner = document.createElement('div');
            banner.id = 'resume-banner';
            banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:2000;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;padding:14px 18px;box-shadow:0 4px 20px rgba(0,0,0,.10);display:flex;align-items:center;gap:14px;max-width:380px;width:calc(100% - 32px)';
            banner.innerHTML = `
                <span style="font-size:24px;flex-shrink:0">📋</span>
                <div style="flex:1">
                    <div style="font-size:14px;font-weight:700;color:#0F172A;font-family:'DM Sans',sans-serif">Resume your previous screening?</div>
                    <div style="font-size:12px;color:#64748B;font-family:'DM Sans',sans-serif">${count} test${count>1?'s':''} completed — pick up where you left off.</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                    <button onclick="RESUME.accept()" style="padding:8px 14px;background:#1A56DB;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:36px">Resume</button>
                    <button onclick="RESUME.dismiss()" style="padding:6px 14px;background:none;border:1px solid #E2E8F0;border-radius:8px;font-size:12px;color:#94A3B8;cursor:pointer;font-family:'DM Sans',sans-serif">Dismiss</button>
                </div>`;
            document.body.appendChild(banner);
            window.RESUME = {
                accept() {
                    _sessionId    = snap.sessionId;
                    _sessionToken = snap.token;
                    S.patientName = snap.patientName;
                    S.completed   = snap.completed;
                    if (snap.calibPPMM) { S.calibPPMM = snap.calibPPMM; S.calibDone = snap.calibDone; }
                    if (snap.currentEye) { S.currentEye = snap.currentEye; selectEye(snap.currentEye); }
                    banner.remove();
                    advanceSequence();
                },
                dismiss() { localStorage.removeItem('ocu_progress'); banner.remove(); }
            };
        } catch(e) {}
    }

    // FEATURE-10: _checkResume is called from init() after session creation
    function _checkAmbientLight() {
        if (!('AmbientLightSensor' in window)) return;
        try {
            const sensor = new AmbientLightSensor();
            sensor.addEventListener('reading', () => {
                const lux = sensor.illuminance;
                sensor.stop();
                if (lux < 20) {
                    toast('💡 Room is very dark — raise ambient lighting slightly for best accuracy.', 6000);
                } else if (lux > 2000) {
                    toast('🌅 Very bright environment — shield your screen from direct light if possible.', 6000);
                }
            });
            sensor.addEventListener('error', () => {});
            sensor.start();
        } catch(e) {}
    }

    let _ptqShown = false;

    // ENG-07: Global error boundary — catches mid-test API failures gracefully
    function _testError(testName, e) {
        console.error(`[OcuScan] ${testName} error:`, e);
        const isExpired = e?.sessionExpired || e?.status === 401 || e?.status === 403;
        const msg = isExpired
            ? 'Your session has expired. Please start a new screening.'
            : (e?.message || 'Network error — please check your connection.');
        toast(`⚠ ${msg}`, 7000);
        document.querySelectorAll('.ocu-err-overlay').forEach(o=>o.remove());
        const overlay = document.createElement('div');
        overlay.className = 'ocu-err-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:4000;background:rgba(15,23,42,.8);display:flex;align-items:center;justify-content:center;padding:24px';
        const actions = isExpired
            ? `<button onclick="localStorage.removeItem('ocu_progress');location.reload()" style="padding:14px;background:#1A56DB;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:44px">Start New Screening</button>`
            : `<button onclick="this.closest('.ocu-err-overlay').remove();App.startTest('${testName}')" style="padding:14px;background:#1A56DB;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:44px">Retry Test</button>
               <button onclick="location.href='index.html'" style="padding:12px;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:12px;font-size:14px;color:#475569;cursor:pointer;font-family:'DM Sans',sans-serif;min-height:44px">Leave Screening</button>`;
        overlay.innerHTML = `<div style="background:#fff;border-radius:20px;padding:28px;max-width:340px;width:100%;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.2)">
            <div style="font-size:36px;margin-bottom:12px">${isExpired?'⏱️':'⚠️'}</div>
            <div style="font-size:17px;font-weight:700;color:#0F172A;font-family:'DM Sans',sans-serif;margin-bottom:8px">${isExpired?'Session Expired':'Test interrupted'}</div>
            <div style="font-size:13px;color:#64748B;font-family:'DM Sans',sans-serif;margin-bottom:20px;line-height:1.6">${msg}${isExpired?'':' Your other completed tests are safe.'}</div>
            <div style="display:flex;flex-direction:column;gap:10px">${actions}</div>
        </div>`;
        document.body.appendChild(overlay);
    }

    function goSetup(){
        if (!S.cameraOk) _showCamModal();
    }
    function _showCamModal(){const m=$('cam-perm-modal');if(!m||m.dataset.shown)return;m.dataset.shown='1';m.style.display='flex';gsap.fromTo('#cam-perm-inner',{y:40,opacity:0,scale:.93},{y:0,opacity:1,scale:1,duration:.45,ease:'back.out(1.6)'})}
    function _hideCamModal(grant){const m=$('cam-perm-modal');gsap.to('#cam-perm-inner',{y:24,opacity:0,scale:.95,duration:.25,ease:'power2.in',onComplete:()=>m.style.display='none'});if(grant)setTimeout(startCamera,300)}
    window._hideCamModal=_hideCamModal;
    function goCalib(){showScreen('calib');requestAnimationFrame(()=>requestAnimationFrame(()=>initCalib()))}

    function initCalib(){
        const screen=$('screen-calib'), slider=$('calib-slider'), bar=$('calib-bar'), px=$('calib-px-readout');
        if(!screen||!slider||!bar)return;

        // "Random light cyan gradient" — a fresh, tasteful angle each time this
        // screen is entered, picked from a small curated set (not truly
        // arbitrary — every option is designed to look intentional).
        const angles=['115deg','135deg','150deg','165deg'];
        screen.style.setProperty('--calib-angle', angles[Math.floor(Math.random()*angles.length)]);

        const DEFAULT_PX = Math.round(RULER_MM/25.4*96); // 96 CSS-dpi as a starting guess only
        if(!slider.dataset.wired){
            slider.value = S.cardWidthPx || DEFAULT_PX;
            const render=()=>{
                const w=parseFloat(slider.value);
                S.cardWidthPx=w;
                bar.style.width=w+'px';
                if(px)px.textContent=Math.round(w)+' px';
            };
            slider.addEventListener('input',()=>{
                render();
                screen.classList.add('is-dragging');
                clearTimeout(slider._dragT);
                slider._dragT=setTimeout(()=>screen.classList.remove('is-dragging'),250);
            });
            slider.dataset.wired='1';
            render();
        } else {
            slider.value = S.cardWidthPx || DEFAULT_PX;
            bar.style.width=slider.value+'px';
            if(px)px.textContent=Math.round(parseFloat(slider.value))+' px';
        }
    }

    function confirmCalib(){
        const w=S.cardWidthPx || Math.round(RULER_MM/25.4*96);
        const ppmm=w/RULER_MM;
        S.calibPPMM=ppmm; S.calibDPI=ppmm*25.4; S.calibDone=true;
        toast(`✓ Calibration: ${ppmm.toFixed(3)} px/mm`);
        setTimeout(()=>beginTestSequence(),800);
    }

    function skipCalib(){
        S.calibPPMM=96/25.4; S.calibDPI=96; S.calibDone=false;
        toast('⚠ Using estimated 96 DPI.');
        setTimeout(()=>beginTestSequence(),800);
    }
    // Fixed test order — Acuity and Near and Diopter run right-eye-then-left-eye;
    // Contrast runs once, both eyes open. advanceSequence() is the single place
    // that decides "what's next" — called after every test finishes, after
    // calibration, and when resuming a saved session.
    const TEST_SEQUENCE = [
        {test:'snellen',  eye:'OD'}, {test:'snellen',  eye:'OS'},
        {test:'near',     eye:'OD'}, {test:'near',     eye:'OS'},
        {test:'contrast', eye:null},
        {test:'diopter',  eye:'OD'}, {test:'diopter',  eye:'OS'},
    ];
    function _stepDone(step){
        return step.eye ? !!S.completed[step.test+'-'+step.eye] : !!S.completed[step.test];
    }
    function advanceSequence(){
        const next = TEST_SEQUENCE.find(step => !_stepDone(step));
        if(!next){ goResults(); return; }
        if(next.eye && S.currentEye!==next.eye){ S.currentEye=next.eye; selectEye(next.eye); }
        startTest(next.test);
    }
    // Called once, right after calibration — replaces the old "go to menu" entry.
    // Runs the environment checks once (they used to re-run every menu visit,
    // which no longer makes sense with no menu to return to), shows the
    // "prepare your screen" modal once, then hands off to advanceSequence().
    function beginTestSequence(){
        _checkAmbientLight();
        _showAccuracyBanner();
        S.currentEye='OD'; selectEye('OD');
        if(!_ptqShown && window.PTQ){
            _ptqShown=true;
            setTimeout(()=>PTQ.open(),200);
        } else {
            advanceSequence();
        }
    }
    function goResults(){renderResults()}
    // "← Retake Tests" on the results screen — resets progress and restarts
    // from Acuity-OD. Skips beginTestSequence()'s PTQ/ambient-light checks
    // since those are genuinely one-time-per-visit, not per-attempt.
    function retakeTests(){
        EYEGATE.reset();
        S.completed={};
        S.currentEye='OD'; selectEye('OD');
        _saveProgress();
        advanceSequence();
    }
    const EYEGATE=(()=>{
        const TEST_NAMES={snellen:'Visual Acuity',near:'Near Vision',diopter:'Diopter'};
        let _cb=null,_pendingKey=null,_okKey=null;
        function open(test,eye,cb){
            const g=$('eye-gate');
            const key=test+'-'+eye;
            if(!g||!eye||_okKey===key){cb();return}
            const testing=eye==='OD'?'right':'left',closing=eye==='OD'?'left':'right';
            const cap=w=>w.charAt(0).toUpperCase()+w.slice(1);
            $('eg-eyebrow').textContent=`${cap(testing)} eye · ${TEST_NAMES[test]||'Test'}`;
            $('eg-title').textContent=`Close your ${closing} eye`;
            $('eg-sub').textContent=`We're about to test your ${testing} eye. Gently close your ${closing} eye, or cover it with your palm without pressing on it.`;
            $('eg-btn-text').textContent=`I've closed my ${closing} eye`;
            $('eg-note').textContent=`Keep your ${testing} eye open and look at the screen.`;
            $('eg-face').setAttribute('data-closed',closing);
            _cb=cb;_pendingKey=key;
            g.classList.add('open');g.setAttribute('aria-hidden','false');
            TTS.say(`Close your ${closing} eye. Tap the button once it is closed.`,true);
            setTimeout(()=>{const b=$('eg-btn');if(b)b.focus({preventScroll:true})},80);
        }
        function confirm(){
            const g=$('eye-gate');
            if(g){g.classList.remove('open');g.setAttribute('aria-hidden','true')}
            _okKey=_pendingKey;
            const cb=_cb;_cb=null;
            if(cb)cb();
        }
        function reset(){
            _okKey=null;_cb=null;_pendingKey=null;
            const g=$('eye-gate');
            if(g){g.classList.remove('open');g.setAttribute('aria-hidden','true')}
        }
        return{open,confirm,reset};
    })();

    function _runTest(name){switch(name){case'snellen':startSnellen();break;case'near':startNear();break;case'diopter':DIOP.start();break;case'contrast':CS.start();break}}
    function startTest(name){
        if(name==='snellen'||name==='near'||name==='diopter')EYEGATE.open(name,S.currentEye,()=>_runTest(name));
        else _runTest(name);
    }

    /* ── FEATURE-04: Contrast Sensitivity ──────────────────────── */
    const CS = {
        _row:0, _total:6, _inFlight:false,
        async start(){
            this._inFlight=false;
            showScreen('contrast'); setProgress(60);
            GESTUREALERT.onTestStart('contrast', null);
            try {
                const data = await api('/api/contrast/start');
                if(!data.ok) throw new Error(data.error||'Could not start contrast test');
                this._row=0; this._total=data.total;
                await this._renderRow(data.row, data.contrast);
                TTS.say("Contrast test. Use both eyes. Tap yes if you can clearly read the letters, or too faint if you can't.",true);
            } catch(e){ _testError('contrast', e); }
        },
        async _renderRow(row, contrast){
            const canvas=$('cs-canvas'); if(!canvas) return;
            const ctx=canvas.getContext('2d');
            const dpr=window.devicePixelRatio||1;
            const cssW=canvas.clientWidth||canvas.width||360;
            const cssH=canvas.clientHeight||canvas.height||200;
            if(canvas.width!==Math.round(cssW*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);canvas.style.width=cssW+'px';canvas.style.height=cssH+'px';}
            const ld = await api('/api/contrast/letters');
            if(!ld.ok) throw new Error(ld.error||'Could not load contrast row');
            ctx.clearRect(0,0,canvas.width,canvas.height);
            ctx.save(); ctx.scale(dpr,dpr);
            ctx.fillStyle='#FFFFFF'; ctx.fillRect(0,0,cssW,cssH);
            const grey = Math.round(255*(1-contrast));
            ctx.fillStyle=`rgb(${grey},${grey},${grey})`;
            ctx.font=`bold 64px 'Space Mono',monospace`;
            ctx.textAlign='center'; ctx.textBaseline='middle';
            const letters=ld.letters;
            const spacing=cssW/4;
            letters.forEach((l,i)=>ctx.fillText(l, spacing*(i+1), cssH/2));
            ctx.restore();
            const lbl=$('cs-step-lbl'); if(lbl) lbl.textContent=`Row ${row+1} of ${this._total}`;
            const q=$('cs-question'); if(q) q.textContent=`Can you clearly read the letters in row ${row+1}?`;
            setProgress(60+(row/this._total)*10);
            canvas.setAttribute('aria-label',`Contrast row ${row+1}: letters at ${Math.round(contrast*100)}% contrast`);
            document.querySelectorAll('[onclick*="CS.answer"]').forEach(b=>{b.disabled=false;b.style.opacity=''}); // FIX: restore after previous run's finish
            this._inFlight=false; // ready for next answer
        },
        async answer(canRead){
            if(this._inFlight) return;
            this._inFlight=true;
            try {
                const data = await api('/api/contrast/answer',{canRead});
                if(!data.ok) throw new Error(data.error||'Could not save your answer');
                if(data.action==='finish'){
                    S.completed['contrast']=true;
                    _saveProgress();
                    // Clear canvas and disable buttons immediately — prevents "frozen" look during 900ms delay
                    const cv=$('cs-canvas');
                    if(cv){const cx=cv.getContext('2d');cx.clearRect(0,0,cv.width,cv.height);cx.fillStyle='#0d1a30';cx.fillRect(0,0,cv.width,cv.height);}
                    document.querySelectorAll('[onclick*="CS.answer"]').forEach(b=>{b.disabled=true;b.style.opacity='0.4';});
                    const ql=$('cs-question');if(ql)ql.textContent='Analysing results…';
                    const score=data.result.score;
                    toast(score>=80?'✓ Contrast sensitivity normal.':'⚠ Reduced contrast sensitivity noted.');
                    setProgress(70);
                    setTimeout(()=>advanceSequence(),900);
                    // leave _inFlight=true — navigating away
                } else {
                    await this._renderRow(data.row, data.contrast); // resets _inFlight on success
                }
            } catch(e){ this._inFlight=false; _testError('contrast', e); }
        }
    };
    window.CS=CS;
    function deleteAllData(){if(!confirm('Delete ALL OcuScan data?'))return;localStorage.clear();toast('All data deleted. Reloading…');setTimeout(()=>location.reload(),1400)}

    function openResearch(){if($('research-modal'))$('research-modal').style.display='flex'}
    function closeResearch(){if($('research-modal'))$('research-modal').style.display='none'}
    function showWhitepaper(){const c=$('wp-content');if(c)c.innerHTML='<h3>OcuScan Pro — Tamper-Proof Architecture</h3><p>All scoring logic runs on the Railway backend. The client only renders questions and forwards raw user input. Correct answers are never sent to the client.</p>';if($('wp-modal'))$('wp-modal').style.display='block'}

    /* ── GESTURE ENGINE ─────────────────────────────────────────── */
    const GESTURE=(() => {
        let _sx=0,_sy=0,_st=0,_hi=-1,_lt=0,_ind=null;
        function _showInd(t){if(_ind)_ind.remove();_ind=document.createElement('div');_ind.className='swipe-indicator';_ind.textContent=t;document.body.appendChild(_ind);setTimeout(()=>{if(_ind){_ind.remove();_ind=null}},950)}
        function _cycle(dir){const btns=[...document.querySelectorAll('#choice-grid button')];if(!btns.length)return;_hi=(_hi+dir+btns.length)%btns.length;btns.forEach((b,i)=>{b.style.outline=i===_hi?'2.5px solid var(--cyan)':'';b.style.background=i===_hi?'rgba(0,212,255,.15)':'';b.style.color=i===_hi?'var(--cyan)':''})}
        function _confirm(){const btns=[...document.querySelectorAll('#choice-grid button')];if(_hi>=0&&btns[_hi]){gsap.to(btns[_hi],{scale:.93,duration:.08,yoyo:true,repeat:1});setTimeout(()=>btns[_hi].click(),120);_hi=-1}}
        function _end(dx,dy,dt,adx,ady){const now=Date.now();if(adx<18&&ady<18&&dt<220){if(now-_lt<400)_confirm();_lt=now;return}if(Math.max(adx,ady)<45)return;if(adx>ady){if(dx<0)_cycle(1);else _cycle(-1)}else{if(dy<0&&S.screen==='snellen')cantRead()}}
        return{init(){const stage=$('opto-stage');if(!stage)return;stage.addEventListener('touchstart',e=>{_sx=e.touches[0].clientX;_sy=e.touches[0].clientY;_st=Date.now()},{passive:true});stage.addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-_sx,dy=e.changedTouches[0].clientY-_sy;_end(dx,dy,Date.now()-_st,Math.abs(dx),Math.abs(dy))},{passive:true});let _md=false;stage.addEventListener('mousedown',e=>{_md=true;_sx=e.clientX;_sy=e.clientY;_st=Date.now()});stage.addEventListener('mouseup',e=>{if(!_md)return;_md=false;const dx=e.clientX-_sx,dy=e.clientY-_sy;_end(dx,dy,Date.now()-_st,Math.abs(dx),Math.abs(dy))})},reset(){_hi=-1}};
    })();

    /* ── INIT ────────────────────────────────────────────────────── */
    const RM={active:false,keyBuffer:'',init(){document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;RM.keyBuffer=(RM.keyBuffer+e.key).slice(-9).toUpperCase();if(RM.keyBuffer.endsWith('IITB2026')){RM.active=true;if($('research-badge')){$('research-badge').style.display='block';gsap.fromTo('#research-badge',{scale:.6,opacity:0},{scale:1,opacity:1,duration:.5,ease:'back.out(2)'})}toast('⚗ Research Mode Unlocked')}})}};
    RM.init();CONSENT.init();PWA.init();
    window.CONSENT=CONSENT;window.ENV=ENV;window.PWA=PWA;

    async function init(){
        const hideLoading=()=>{const lo=$('loading');if(lo&&lo.style.display!=='none')gsap.to(lo,{opacity:0,duration:.7,onComplete:()=>lo.style.display='none'})};
        const ft=setTimeout(hideLoading,5000);

        // FIX: Create session FIRST — session creation must not depend on camera/MediaPipe
        // This ensures _sessionId is always set before consent screen proceeds
        try{
            await createSession();
        }catch(e){
            console.warn('[OcuScan] Session creation failed:',e);
            // Show error on the calibration screen's primary button if session fails
            const startBtn=$('calib-auto-main-btn');
            if(startBtn){
                startBtn.textContent='⚠ Server offline — refresh';
                startBtn.style.background='#DC2626';
                startBtn.onclick=()=>location.reload();
            }
        }

        // Load MediaPipe in background AFTER session is ready — camera is optional
        try{await initMediaPipe()}catch(e){S.mpReady=false;if($('load-sub'))$('load-sub').textContent='Manual mode.'}

        clearTimeout(ft);setTimeout(hideLoading,S.mpReady?2000:1200);
        setTimeout(()=>GESTURE.init(),700);

        // Camera-permission trigger and resume-check now fire from CONSENT.proceed(),
        // once the user has actually agreed — see the CONSENT object above.
    }
    init();

    return {
        goCalib,confirmCalib,skipCalib,retakeTests,
        goResults,startCamera,skipCamera,
        selectEye,startTest,cantRead,eyeGateConfirm:()=>EYEGATE.confirm(),
        diopterBlurNow:()=>DIOP.blurNow(),diopterCantBlur:()=>DIOP.cantBlur(),
        nearAnswer,deleteAllData,openResearch,closeResearch,
        exportCSV,generatePDF,showWhitepaper,
        _S:S,
        // Expose for PTQ modal, ANIM, and external tools
        get _sid()   { return _sessionId; },
        get _tok()   { return _sessionToken; },
        get _apiBase(){ return RAILWAY_API_URL; },
        resetPTQ()   { _ptqShown = false; },  // call when starting fresh session
    };
})();
window.App = App; // FIX: `const App` is NOT a window property; main.html guards use `window.App && App.x` (PTQ 'I'm Ready', stepper, history)
