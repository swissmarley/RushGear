/**
 * Race HUD: speed/gear/rpm, lap & sector timing, position/standings, event feed, minimap,
 * corner names, countdown, damage and FPS. Pure DOM; updated at display rate.
 */
import { formatTime, formatDelta, ordinal, clamp } from '../core/math.js';

export class HUD {
	constructor( root ) {
		this.root = document.createElement( 'div' );
		this.root.id = 'hud';
		this.root.innerHTML = `
			<div class="hud-laps"><div class="pos"><span id="h-pos">1</span><small id="h-posof">/1</small></div><div class="lap" id="h-lap">Lap 1 / 3</div></div>
			<div class="hud-times">
				<div class="cur" id="h-cur">0:00.000</div>
				<div><span class="lbl">Last</span><span id="h-last">--:--.---</span></div>
				<div><span class="lbl">Best</span><span id="h-best">--:--.---</span></div>
				<div><span class="lbl">Record</span><span id="h-rec">--:--.---</span></div>
				<div class="sectors"><span id="h-s0"></span><span id="h-s1"></span><span id="h-s2"></span></div>
				<div class="hud-delta" id="h-delta"></div>
			</div>
			<div class="hud-corner" id="h-corner"></div>
			<div class="hud-standings" id="h-stand"></div>
			<canvas class="hud-map" id="h-map" width="220" height="220"></canvas>
			<div class="hud-feed" id="h-feed"></div>
			<div class="hud-gear" id="h-gear">1</div>
			<div class="hud-rpm" id="h-rpm"><i></i></div>
			<div class="hud-aids" id="h-aids"><span id="h-abs">ABS</span> <span id="h-tc">TC</span> <span id="h-auto">AUTO</span></div>
			<div class="hud-damage" id="h-dmg"><i></i></div>
			<div class="hud-speed"><div class="kmh" id="h-kmh">0</div><div class="unit">km/h</div></div>
			<div class="hud-center" id="h-center"></div>
			<div class="hud-wrong" id="h-wrong" style="display:none">WRONG WAY</div>
			<div class="hud-fps" id="h-fps"></div>`;
		root.appendChild( this.root );
		const $ = ( id ) => this.root.querySelector( '#' + id );
		this.el = {
			pos: $( 'h-pos' ), posof: $( 'h-posof' ), lap: $( 'h-lap' ), cur: $( 'h-cur' ), last: $( 'h-last' ), best: $( 'h-best' ), rec: $( 'h-rec' ),
			s: [ $( 'h-s0' ), $( 'h-s1' ), $( 'h-s2' ) ], delta: $( 'h-delta' ), corner: $( 'h-corner' ), stand: $( 'h-stand' ), map: $( 'h-map' ),
			feed: $( 'h-feed' ), gear: $( 'h-gear' ), rpm: $( 'h-rpm' ), rpmBar: $( 'h-rpm' ).firstElementChild, kmh: $( 'h-kmh' ), center: $( 'h-center' ),
			wrong: $( 'h-wrong' ), fps: $( 'h-fps' ), dmg: $( 'h-dmg' ).firstElementChild, abs: $( 'h-abs' ), tc: $( 'h-tc' ), auto: $( 'h-auto' )
		};
		this.mapCtx = this.el.map.getContext( '2d' );
		this.mapData = null;
		this._lastStandings = '';
		this._fpsAcc = 0; this._fpsN = 0; this._fpsT = 0;
	}

	show( on ) { this.root.classList.toggle( 'on', on ); }

	setTrack( track ) {
		// precompute minimap projection
		const b = track.bounds;
		const size = 200, pad = 12;
		const sx = size / ( b.maxX - b.minX ), sz = size / ( b.maxZ - b.minZ );
		const s = Math.min( sx, sz );
		const ox = pad + ( size - ( b.maxX - b.minX ) * s ) / 2, oz = pad + ( size - ( b.maxZ - b.minZ ) * s ) / 2;
		this.mapData = { track, s, ox, oz, b, pts: track.samples.filter( ( _, i ) => i % 3 === 0 ).map( ( sm ) => [ ox + ( sm.pos.x - b.minX ) * s, oz + ( sm.pos.z - b.minZ ) * s ] ) };
	}

	feed( text, hi = false ) {
		const d = document.createElement( 'div' );
		d.textContent = text;
		if ( hi ) d.classList.add( 'hi' );
		this.el.feed.prepend( d );
		while ( this.el.feed.children.length > 5 ) this.el.feed.lastChild.remove();
		setTimeout( () => d.remove(), 6000 );
	}

	center( text, sub = '', small = false ) {
		this.el.center.innerHTML = text ? `${text}${sub ? `<div class="sub">${sub}</div>` : ''}` : '';
		this.el.center.classList.toggle( 'small', small );
	}

	update( info, dt ) {
		const e = this.el, v = info.vehicle;
		e.kmh.textContent = Math.round( v.speedKmh ).toString();
		const g = v.engine.gear;
		e.gear.textContent = g === - 1 ? 'R' : g === 0 ? 'N' : String( g );
		const rpmF = clamp( v.engine.rpm / v.def.engine.redline, 0, 1 );
		e.rpmBar.style.width = ( rpmF * 100 ).toFixed( 1 ) + '%';
		e.rpm.classList.toggle( 'limit', rpmF > 0.95 );
		e.abs.classList.toggle( 'on', v.aids.abs && v.wheels.some( ( w ) => w.absActive ) );
		e.tc.classList.toggle( 'on', v.aids.tc && v.wheels.some( ( w ) => w.tcActive ) );
		e.auto.classList.toggle( 'on', v.aids.autoGear );
		e.dmg.style.width = ( v.damage * 100 ).toFixed( 0 ) + '%';

		const r = info.race;
		if ( r ) {
			const me = r.entryOf( v );
			e.pos.textContent = String( me.position );
			e.posof.textContent = '/' + r.entries.length;
			e.lap.textContent = r.mode === 'timetrial' ? `Lap ${me.lap}` : r.mode === 'qualifying' ? `Qualifying · ${formatTime( Math.max( 0, r.timeLimit - r.time ) )}` : `Lap ${Math.min( me.lap, r.laps )} / ${r.laps}`;
			e.cur.textContent = formatTime( me.currentLapTime );
			e.last.textContent = formatTime( me.lastLap );
			e.best.textContent = formatTime( me.bestLap );
			e.rec.textContent = formatTime( r.record );
			for ( let i = 0; i < 3; i ++ ) {
				const el = e.s[ i ];
				el.className = '';
				const st = me.sectorStatus[ i ];
				if ( st ) el.classList.add( st );
			}
			if ( me.deltaToBest !== null && isFinite( me.deltaToBest ) ) {
				e.delta.textContent = formatDelta( me.deltaToBest );
				e.delta.className = 'hud-delta ' + ( me.deltaToBest < 0 ? 'neg' : 'pos' );
			} else { e.delta.textContent = ''; }
			e.wrong.style.display = me.wrongWay ? 'block' : 'none';
			// corner name
			const c = v.proj.corner;
			const corner = c >= 0 ? r.track.corners[ c ] : null;
			e.corner.innerHTML = corner ? `<b>${corner.name}</b>` : '';
			// standings (throttled by content hash)
			const rows = r.standings.slice( 0, 9 ).map( ( en ) => `<div class="${en.vehicle === v ? 'me' : ''}"><span>${en.position}</span><span>${en.name}</span><span>${en.gapText}</span></div>` ).join( '' );
			if ( rows !== this._lastStandings ) { e.stand.innerHTML = rows; this._lastStandings = rows; }
		}
		// minimap
		if ( this.mapData && r ) this._drawMap( r, v );
		// fps
		this._fpsAcc += dt; this._fpsN ++;
		if ( this._fpsAcc > 0.5 ) { e.fps.textContent = `${Math.round( this._fpsN / this._fpsAcc )} fps · ${info.backend} · ${info.quality}`; this._fpsAcc = 0; this._fpsN = 0; }
	}

	_drawMap( race, me ) {
		const ctx = this.mapCtx, m = this.mapData;
		ctx.clearRect( 0, 0, 224, 224 );
		ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineJoin = 'round';
		ctx.beginPath();
		for ( let i = 0; i < m.pts.length; i ++ ) { const p = m.pts[ i ]; if ( i === 0 ) ctx.moveTo( p[ 0 ], p[ 1 ] ); else ctx.lineTo( p[ 0 ], p[ 1 ] ); }
		ctx.closePath(); ctx.stroke();
		ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
		// start line
		const s0 = m.track.samples[ 0 ];
		ctx.fillStyle = '#ffb400';
		ctx.fillRect( m.ox + ( s0.pos.x - m.b.minX ) * m.s - 3, m.oz + ( s0.pos.z - m.b.minZ ) * m.s - 3, 6, 6 );
		for ( const en of race.entries ) {
			const p = en.vehicle.position;
			const x = m.ox + ( p.x - m.b.minX ) * m.s, y = m.oz + ( p.z - m.b.minZ ) * m.s;
			ctx.beginPath(); ctx.arc( x, y, en.vehicle === me ? 5 : 3.5, 0, Math.PI * 2 );
			ctx.fillStyle = en.vehicle === me ? '#ff3b1f' : en.color || '#9fd4ff';
			ctx.fill();
			if ( en.vehicle === me ) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
		}
	}
}
