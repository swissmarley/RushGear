/**
 * Headless smoke test: boots the game in Chromium (WebGPU via SwiftShader if no GPU),
 * starts a quick race, drives for a few seconds and reports console errors + screenshots.
 *
 *   node scripts/smoke.mjs [--webgl] [--shots dir] [--seconds N]
 */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( k ); return i >= 0 ? args[ i + 1 ] : d; };
const forceWebGL = args.includes( '--webgl' );
const shots = opt( '--shots', 'scratch/shots' );
const seconds = parseFloat( opt( '--seconds', '6' ) );
mkdirSync( shots, { recursive: true } );

const server = await createServer( { root: process.cwd(), server: { port: 5199, host: '127.0.0.1', strictPort: true, hmr: false, watch: null }, logLevel: 'error' } );
await server.listen();

const browser = await chromium.launch( {
	executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', headless: true,
	args: [ '--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader' ]
} );
const preset = opt( '--preset', 'low' );
const page = await browser.newPage( { viewport: { width: parseInt( opt( '--width', '800' ) ), height: parseInt( opt( '--height', '450' ) ) } } );
page.setDefaultTimeout( 180000 );
await page.addInitScript( ( preset ) => { try { localStorage.setItem( 'rushgear.v1.settings', JSON.stringify( { preset, adaptive: false } ) ); } catch {} }, preset );
const errors = [], warnings = [];
page.on( 'console', ( m ) => { const t = m.text(); if ( m.type() === 'error' ) errors.push( t ); else if ( m.type() === 'warning' ) warnings.push( t ); else if ( ! t.startsWith( '[vite]' ) ) console.log( '[log]', t.slice( 0, 300 ) ); } );
page.on( 'pageerror', ( e ) => errors.push( 'PAGEERROR ' + e.message + '\n' + ( e.stack || '' ) ) );

if ( forceWebGL ) await page.addInitScript( () => { Object.defineProperty( navigator, 'gpu', { value: undefined } ); } );
const fx = opt( '--fx', '' );
await page.goto( 'http://127.0.0.1:5199/' + ( fx ? '?fx=' + fx : '' ), { waitUntil: 'commit', timeout: 120000 } );
await page.waitForFunction( () => window.RUSHGEAR && window.RUSHGEAR.state === 'menu', null, { timeout: 120000 } ).catch( () => console.log( 'menu not reached' ) );
console.log( 'backend:', await page.evaluate( () => window.RUSHGEAR.gfx?.backend ) );
await page.screenshot( { path: `${shots}/01-menu.png` } );

if ( args.includes( '--garage' ) ) {
	await page.evaluate( () => window.RUSHGEAR.menu.garage() );
	await page.waitForTimeout( 4000 );
	await page.screenshot( { path: `${shots}/00-garage.png` } );
	await page.evaluate( () => window.RUSHGEAR.menu.main( window.RUSHGEAR.info ) );
	if ( args.includes( '--garage-only' ) ) { console.log( `${errors.length} console errors` ); for ( const e of errors.slice( 0, 10 ) ) console.log( ' ERR', e.slice( 0, 800 ) ); await browser.close(); await server.close(); process.exit( errors.length ? 1 : 0 ); }
}
const flow = opt( '--flow', null );
if ( flow === 'champ' ) {
	// championship: qualifying (time-limited) → results → standings → race 1 → results
	await page.evaluate( () => window.RUSHGEAR.startChampionship( window.RUSHGEAR.menu.selection ) );
	await page.waitForFunction( () => window.RUSHGEAR.state === 'race' && window.RUSHGEAR.race?.mode === 'qualifying' );
	await page.evaluate( () => { const g = window.RUSHGEAR; g.autopilot = true; g.race.timeLimit = 40; g.simulate( 70 ); } );
	await page.waitForFunction( () => window.RUSHGEAR.race?.finished, null, { timeout: 60000 } );
	console.log( 'qualifying:', await page.evaluate( () => window.RUSHGEAR.race.standings.map( ( e ) => e.name + ' ' + e.gapText ).join( ' | ' ) ) );
	await page.waitForTimeout( 800 );
	await page.evaluate( () => window.RUSHGEAR.championshipContinue() );
	await page.evaluate( () => window.RUSHGEAR.championshipNext() );
	await page.waitForFunction( () => window.RUSHGEAR.state === 'race' && window.RUSHGEAR.race?.mode === 'race', null, { timeout: 120000 } );
	await page.evaluate( () => { const g = window.RUSHGEAR; g.autopilot = true; g.race.laps = 1; for ( const e of g.race.entries ) {} g.simulate( 130 ); } );
	console.log( 'race1 finished:', await page.evaluate( () => window.RUSHGEAR.race.finished ), await page.evaluate( () => window.RUSHGEAR.race.standings.slice( 0, 3 ).map( ( e ) => e.name + ' ' + e.gapText ).join( ' | ' ) ) );
	await page.waitForTimeout( 3000 );
	await page.evaluate( () => window.RUSHGEAR.championshipContinue() );
	console.log( 'table:', await page.evaluate( () => window.RUSHGEAR.championship.table().slice( 0, 3 ).map( ( r ) => r.name + ' ' + r.points ).join( ' | ' ) ) );
	await page.screenshot( { path: `${shots}/flow-champ.png` } );
} else if ( flow === 'tt' ) {
	await page.evaluate( () => window.RUSHGEAR.startTimeTrial( window.RUSHGEAR.menu.selection ) );
	await page.waitForFunction( () => window.RUSHGEAR.state === 'race' && window.RUSHGEAR.race?.mode === 'timetrial' );
	await page.evaluate( () => { const g = window.RUSHGEAR; g.autopilot = true; g.simulate( 200 ); } );
	console.log( 'timetrial:', await page.evaluate( () => { const g = window.RUSHGEAR; const e = g.race.entryOf( g.playerCar.vehicle ); return JSON.stringify( { laps: e.lapsDone, best: e.bestLap, ghost: !! g.ghostData, ghostLap: g.ghostData?.lapTime, ghostFrames: g.ghostData?.frames.length, record: g.race.record } ); } ) );
	await page.evaluate( () => window.RUSHGEAR.startReplay() );
	await page.waitForTimeout( 1500 );
	console.log( 'replay:', await page.evaluate( () => JSON.stringify( { state: window.RUSHGEAR.state, t: window.RUSHGEAR.replay?.time, dur: window.RUSHGEAR.replay?.duration } ) ) );
	await page.screenshot( { path: `${shots}/flow-replay.png` } );
	await page.evaluate( () => window.RUSHGEAR.exitReplay() );
	await page.waitForTimeout( 300 );
	console.log( 'after replay state:', await page.evaluate( () => window.RUSHGEAR.state ) );
}
if ( flow ) { console.log( `${errors.length} console errors` ); for ( const e of errors.slice( 0, 10 ) ) console.log( ' ERR', e.slice( 0, 900 ) ); await browser.close(); await server.close(); process.exit( errors.length ? 1 : 0 ); }
const trackId = opt( '--track', null ), carId = opt( '--car', null );
await page.evaluate( ( [ t, c ] ) => { const g = window.RUSHGEAR; if ( t ) g.menu.selection.trackId = t; if ( c ) g.menu.selection.carId = c; g.startQuickRace( g.menu.selection ); }, [ trackId, carId ] );
await page.waitForFunction( () => window.RUSHGEAR.state === 'race', null, { timeout: 120000 } ).catch( () => console.log( 'race not reached' ) );
await page.waitForTimeout( 1500 );
await page.evaluate( () => { if ( window.RUSHGEAR.race ) window.RUSHGEAR.race.countdown = Math.min( window.RUSHGEAR.race.countdown, 0.3 ); } );
await page.screenshot( { path: `${shots}/02-grid${trackId ? '-' + trackId : ''}.png` } );
// drive deterministically: autopilot + synchronous simulation, then a few real frames
await page.evaluate( ( secs ) => { const g = window.RUSHGEAR; g.autopilot = true; g.simulate( secs ); }, seconds );
if ( args.includes( '--nohud' ) ) await page.evaluate( () => { document.getElementById( 'hud' ).style.display = 'none'; } );
await page.waitForTimeout( 1500 );
const telemetry = await page.evaluate( () => { const g = window.RUSHGEAR; const v = g.playerCar?.vehicle; return v ? { paint: g.playerCar.uniforms.color.value.getHexString(), carId: g.playerCar.def.id, cars: g.cars.length, pos1: g.race?.standings[ 0 ]?.name, playerPos: g.race?.entryOf( v ).position, speedKmh: v.speedKmh.toFixed( 1 ), rpm: v.engine.rpm.toFixed( 0 ), gear: v.engine.gear, pos: v.position.toArray().map( ( x ) => x.toFixed( 1 ) ), s: v.proj.s.toFixed( 1 ), lateral: v.proj.lateral.toFixed( 2 ), onGround: v.wheels.map( ( w ) => w.onGround ), damage: v.damage.toFixed( 2 ), fps: g.hud.el.fps.textContent } : null; } );
console.log( 'telemetry:', JSON.stringify( telemetry ) );
await page.screenshot( { path: `${shots}/03-driving${trackId ? '-' + trackId : ''}${fx ? '-' + fx.replace( /,/g, '_' ) : ''}.png` } );
for ( const extra of args.filter( ( a ) => a.startsWith( 'eval:' ) ) ) console.log( 'eval', await page.evaluate( extra.slice( 5 ) ) );

console.log( `\n${errors.length} console errors, ${warnings.length} warnings` );
for ( const e of errors.slice( 0, 15 ) ) console.log( ' ERR', e.slice( 0, 1200 ) );
for ( const w of [ ...new Set( warnings ) ].slice( 0, 8 ) ) console.log( ' WARN', w.slice( 0, 400 ) );
await browser.close();
await server.close();
process.exit( errors.length ? 1 : 0 );
