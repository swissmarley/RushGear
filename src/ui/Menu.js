/**
 * Menu system (DOM). Screens: loading, main, mode select, track select, garage, settings,
 * pause, results, championship standings, replay bar. The game drives transitions.
 */
import { TRACKS } from '../world/TrackData.js';
import { CARS } from '../vehicle/CarData.js';
import { PRESETS } from '../core/Settings.js';
import { formatTime, ordinal } from '../core/math.js';

const h = ( html ) => { const t = document.createElement( 'template' ); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const rgb = ( c ) => `rgb(${c.map( ( v ) => Math.round( Math.sqrt( v ) * 255 ) ).join( ',' )})`;

export class Menu {
	constructor( root, game ) {
		this.root = root; this.game = game;
		this.current = null;
		this.selection = { trackId: TRACKS[ 0 ].id, carId: CARS[ 0 ].id, mode: 'quick', laps: 3 };
		this._keyHandler = ( e ) => { if ( e.code === 'Escape' ) this.game.onEscape(); };
		window.addEventListener( 'keydown', this._keyHandler );
	}

	clear() { if ( this.current ) { this.current.remove(); this.current = null; } }
	show( el ) {
		this.clear(); this.current = el; this.root.appendChild( el );
		el.addEventListener( 'click', ( e ) => { if ( e.target.closest( 'button, .card' ) ) this.game.audio?.blip(); } );
		return el;
	}

	loading( status, progress ) {
		if ( ! this.current || ! this.current.classList.contains( 'loading' ) ) {
			this.show( h( `<div class="loading"><div class="logo">Rush <em>Gear</em></div><div class="bar"><i></i></div><div class="status"></div></div>` ) );
		}
		this.current.querySelector( '.status' ).textContent = status;
		this.current.querySelector( '.bar i' ).style.width = ( progress * 100 ).toFixed( 0 ) + '%';
	}

	main( info ) {
		const el = h( `<div class="screen">
			<div class="logo">Rush <em>Gear</em></div>
			<div class="tagline">100% procedural · ${info.backend}</div>
			<div class="menu">
				<button class="primary" data-a="quick">Quick Race <small>${this._trackName()} · ${this._carName()}</small></button>
				<button data-a="championship">Championship <small>Qualifying + 3 races</small></button>
				<button data-a="timetrial">Time Trial <small>Ghost of your best lap</small></button>
				<button data-a="garage">Garage <small>${CARS.length} cars</small></button>
				<button data-a="tracks">Tracks <small>${TRACKS.length} circuits</small></button>
				<button data-a="settings">Settings <small>${PRESETS[ this.game.settings.preset ].label}</small></button>
			</div>
			<div class="hint"><kbd>W/↑</kbd> throttle · <kbd>S/↓</kbd> brake · <kbd>A/D</kbd> steer · <kbd>Space</kbd> handbrake · <kbd>C</kbd> camera · <kbd>R</kbd> replay · <kbd>Esc</kbd> pause</div>
		</div>` );
		el.addEventListener( 'click', ( e ) => {
			const a = e.target.closest( 'button' )?.dataset.a;
			if ( ! a ) return;
			if ( a === 'quick' ) this.game.startQuickRace( this.selection );
			else if ( a === 'championship' ) this.game.startChampionship( this.selection );
			else if ( a === 'timetrial' ) this.game.startTimeTrial( this.selection );
			else if ( a === 'garage' ) this.garage();
			else if ( a === 'tracks' ) this.tracks();
			else if ( a === 'settings' ) this.settings();
		} );
		this.show( el );
		this.game.showGarageCar?.( false );
	}

	_trackName() { return TRACKS.find( ( t ) => t.id === this.selection.trackId )?.name || ''; }
	_carName() { return CARS.find( ( c ) => c.id === this.selection.carId )?.name || ''; }

	tracks() {
		const cards = TRACKS.map( ( t ) => {
			const rec = this.game.records.bestLap( t.id );
			return `<div class="card ${t.id === this.selection.trackId ? 'selected' : ''}" data-id="${t.id}">
				<div class="swatch" style="background:${this._trackSwatch( t )}"></div>
				<h3>${t.name}</h3><p>${t.location}</p>
				<div class="meta"><span>${t.laps} laps</span><span>${rec ? formatTime( rec.time ) : 'no record'}</span></div></div>`;
		} ).join( '' );
		const el = h( `<div class="screen"><div class="panel"><h2>Select circuit</h2><div class="row">${cards}</div><div class="footer"><button class="btn" data-a="back">Back</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => {
			const card = e.target.closest( '.card' );
			if ( card ) { this.selection.trackId = card.dataset.id; this.main( this.game.info ); return; }
			if ( e.target.closest( '[data-a=back]' ) ) this.main( this.game.info );
		} );
		this.show( el );
	}

	_trackSwatch( t ) {
		return { coastal: 'linear-gradient(90deg,#2b7fd6,#f0d9a0)', mountain: 'linear-gradient(90deg,#4a3b7a,#f28f5a)', desert: 'linear-gradient(90deg,#f0a040,#7a2f60)', forest: 'linear-gradient(90deg,#1f3a1d,#6f8a92)', city: 'linear-gradient(90deg,#ff2bd6,#20c5ff)', oval: 'linear-gradient(90deg,#3b84ff,#ffffff)' }[ t.biome ];
	}

	garage() {
		const cards = CARS.map( ( c ) => `<div class="card ${c.id === this.selection.carId ? 'selected' : ''}" data-id="${c.id}">
			<div class="swatch" style="background:${rgb( c.paint.color )}"></div>
			<h3>${c.name}</h3><p>${c.description}</p>
			<div class="meta"><span>${c.class} · ${c.drivetrain}</span><span>${c.mass} kg · ${c.engine.power}</span></div></div>` ).join( '' );
		const el = h( `<div class="screen side"><div class="panel garage"><h2>Garage</h2><div class="row vertical">${cards}</div><div class="footer"><button class="btn" data-a="repaint">Repaint</button><button class="btn" data-a="back">Back</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => {
			const card = e.target.closest( '.card' );
			if ( card ) { this.selection.carId = card.dataset.id; this.game.showGarageCar( true, this.selection.carId ); el.querySelectorAll( '.card' ).forEach( ( c ) => c.classList.toggle( 'selected', c.dataset.id === card.dataset.id ) ); return; }
			if ( e.target.closest( '[data-a=repaint]' ) ) this.game.repaintGarageCar();
			if ( e.target.closest( '[data-a=back]' ) ) this.main( this.game.info );
		} );
		this.show( el );
		this.game.showGarageCar( true, this.selection.carId );
	}

	settings() {
		const s = this.game.settings;
		const seg = ( name, opts, cur ) => `<div class="seg" data-k="${name}">${opts.map( ( o ) => `<button class="${o.v === cur ? 'on' : ''}" data-v="${o.v}">${o.l}</button>` ).join( '' )}</div>`;
		const el = h( `<div class="screen"><div class="panel"><h2>Settings</h2><div class="kv">
			<span>Quality preset</span>${seg( 'preset', Object.keys( PRESETS ).map( ( k ) => ( { v: k, l: PRESETS[ k ].label } ) ), s.preset )}
			<span>Adaptive quality</span>${seg( 'adaptive', [ { v: 'true', l: 'On' }, { v: 'false', l: 'Off' } ], String( s.adaptive ) )}
			<span>Target frame rate</span>${seg( 'targetFps', [ { v: '30', l: '30' }, { v: '60', l: '60' }, { v: '120', l: '120' } ], String( s.targetFps ) )}
			<span>ABS</span>${seg( 'abs', [ { v: 'true', l: 'On' }, { v: 'false', l: 'Off' } ], String( s.aids.abs ) )}
			<span>Traction control</span>${seg( 'tc', [ { v: 'true', l: 'On' }, { v: 'false', l: 'Off' } ], String( s.aids.tc ) )}
			<span>Gearbox</span>${seg( 'autoGear', [ { v: 'true', l: 'Auto' }, { v: 'false', l: 'Manual' } ], String( s.aids.autoGear ) )}
			<span>Master volume</span><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-k="volume">
			<span>Music volume</span><input type="range" min="0" max="1" step="0.05" value="${s.music}" data-k="music">
			</div>
			<div class="hint">Ultra targets an RTX 5090-class GPU at 4K: native resolution, 4096² cascaded shadows, SSR, GTAO, DOF, motion blur, god rays, TRAA and transmissive glass. Adaptive quality steps effects down if the frame time exceeds the target.</div>
			<div class="footer"><button class="btn" data-a="back">Back</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => {
			const b = e.target.closest( '.seg button' );
			if ( b ) {
				const k = b.parentElement.dataset.k, v = b.dataset.v;
				b.parentElement.querySelectorAll( 'button' ).forEach( ( x ) => x.classList.toggle( 'on', x === b ) );
				if ( k === 'preset' ) s.setPreset( v );
				else if ( k === 'adaptive' ) { s.adaptive = v === 'true'; s.save(); }
				else if ( k === 'targetFps' ) { s.targetFps = parseInt( v ); s.save(); }
				else { s.aids[ k ] = v === 'true'; s.save(); this.game.applyAids(); }
				return;
			}
			if ( e.target.closest( '[data-a=back]' ) ) this.main( this.game.info );
		} );
		el.addEventListener( 'input', ( e ) => {
			const k = e.target.dataset.k;
			if ( k === 'volume' || k === 'music' ) { s[ k ] = parseFloat( e.target.value ); s.save(); this.game.audio?.setVolumes( s.volume, s.music ); }
		} );
		this.show( el );
	}

	pause() {
		const el = h( `<div class="pause"><div class="panel"><h2>Paused</h2><div class="menu">
			<button data-a="resume">Resume</button><button data-a="restart">Restart</button><button data-a="replay">Watch replay</button><button data-a="settings">Settings</button><button data-a="quit">Quit to menu</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => {
			const a = e.target.closest( 'button' )?.dataset.a;
			if ( a === 'resume' ) this.game.resume();
			else if ( a === 'restart' ) this.game.restartRace();
			else if ( a === 'replay' ) this.game.startReplay();
			else if ( a === 'settings' ) { this.settings(); this.current.querySelector( '[data-a=back]' ).onclick = () => this.pause(); }
			else if ( a === 'quit' ) this.game.quitToMenu();
		} );
		this.show( el );
	}

	results( race, championship ) {
		const rows = race.standings.map( ( en ) => `<tr class="${en.isPlayer ? 'me' : ''}"><td>${en.position}</td><td>${en.name}</td><td>${en.carName}</td><td>${formatTime( en.bestLap )}</td><td>${en.finished ? ( en.position === 1 ? formatTime( en.totalTime ) : en.gapText ) : 'DNF'}</td>${championship ? `<td>${championship.pointsFor( en.position )}</td>` : ''}</tr>` ).join( '' );
		const title = race.mode === 'qualifying' ? 'Qualifying' : race.mode === 'timetrial' ? 'Time Trial' : 'Race result';
		const me = race.standings.find( ( e ) => e.isPlayer );
		const el = h( `<div class="screen"><div class="panel results"><h2>${title} · ${race.track.name}</h2>
			<div style="font-size:40px;font-weight:900;font-style:italic;margin-bottom:12px">${me ? ordinal( me.position ) : ''} ${me && me.position === 1 && race.mode === 'race' ? '· Winner!' : ''}</div>
			<table><tr><th>#</th><th>Driver</th><th>Car</th><th>Best lap</th><th>${race.mode === 'race' ? 'Gap' : 'Time'}</th>${championship ? '<th>Pts</th>' : ''}</tr>${rows}</table>
			<div class="footer"><button class="btn" data-a="replay">Replay</button>${championship ? '<button class="btn" data-a="next">Continue</button>' : '<button class="btn" data-a="restart">Race again</button>'}<button class="btn" data-a="menu">Menu</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => {
			const a = e.target.closest( 'button' )?.dataset.a;
			if ( a === 'replay' ) this.game.startReplay();
			else if ( a === 'restart' ) this.game.restartRace();
			else if ( a === 'next' ) this.game.championshipContinue();
			else if ( a === 'menu' ) this.game.quitToMenu();
		} );
		this.show( el );
	}

	championshipStandings( champ, onContinue ) {
		const rows = champ.table().map( ( r, i ) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${r.name}</td><td>${r.points}</td><td>${r.results.join( ' · ' )}</td></tr>` ).join( '' );
		const el = h( `<div class="screen"><div class="panel results"><h2>Championship · after round ${champ.round} of ${champ.rounds.length}</h2>
			<table><tr><th>#</th><th>Driver</th><th>Points</th><th>Results</th></tr>${rows}</table>
			<div class="footer"><button class="btn primary" data-a="go">${champ.finished ? 'Finish' : 'Next: ' + champ.nextLabel()}</button></div></div></div>` );
		el.addEventListener( 'click', ( e ) => { if ( e.target.closest( '[data-a=go]' ) ) onContinue(); } );
		this.show( el );
	}

	replayBar( replay ) {
		const el = h( `<div class="replay-bar"><button data-a="play">⏯</button><button data-a="slow">0.25×</button><button data-a="normal">1×</button><button data-a="fast">4×</button><button data-a="cam">Camera</button><button data-a="car">Next car</button><span class="t">0:00.000</span><button data-a="exit">Exit</button></div>` );
		el.addEventListener( 'click', ( e ) => {
			const a = e.target.closest( 'button' )?.dataset.a;
			if ( a === 'play' ) replay.playing = ! replay.playing;
			else if ( a === 'slow' ) replay.speed = 0.25; else if ( a === 'normal' ) replay.speed = 1; else if ( a === 'fast' ) replay.speed = 4;
			else if ( a === 'cam' ) this.game.cycleCamera();
			else if ( a === 'car' ) replay.nextCar();
			else if ( a === 'exit' ) this.game.exitReplay();
		} );
		this.show( el );
		return el;
	}

	toast( text ) {
		const t = h( `<div class="toast">${text}</div>` );
		this.root.appendChild( t );
		setTimeout( () => t.remove(), 4000 );
	}
}
