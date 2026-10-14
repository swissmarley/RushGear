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

const server = await createServer( { root: process.cwd(), server: { port: 5199, host: '127.0.0.1', strictPort: true }, logLevel: 'error' } );
await server.listen();

const browser = await chromium.launch( {
	executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', headless: true,
	args: [ '--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader' ]
} );
const page = await browser.newPage( { viewport: { width: 960, height: 540 } } );
const errors = [], warnings = [];
page.on( 'console', ( m ) => { const t = m.text(); if ( m.type() === 'error' ) errors.push( t ); else if ( m.type() === 'warning' ) warnings.push( t ); else if ( ! t.startsWith( '[vite]' ) ) console.log( '[log]', t.slice( 0, 300 ) ); } );
page.on( 'pageerror', ( e ) => errors.push( 'PAGEERROR ' + e.message + '\n' + ( e.stack || '' ) ) );

if ( forceWebGL ) await page.addInitScript( () => { Object.defineProperty( navigator, 'gpu', { value: undefined } ); } );
await page.goto( 'http://127.0.0.1:5199/', { waitUntil: 'commit', timeout: 120000 } );
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
const trackId = opt( '--track', null ), carId = opt( '--car', null );
await page.evaluate( ( [ t, c ] ) => { const g = window.RUSHGEAR; if ( t ) g.menu.selection.trackId = t; if ( c ) g.menu.selection.carId = c; g.startQuickRace( g.menu.selection ); }, [ trackId, carId ] );
await page.waitForFunction( () => window.RUSHGEAR.state === 'race', null, { timeout: 120000 } ).catch( () => console.log( 'race not reached' ) );
await page.waitForTimeout( 1500 );
await page.evaluate( () => { if ( window.RUSHGEAR.race ) window.RUSHGEAR.race.countdown = Math.min( window.RUSHGEAR.race.countdown, 0.3 ); } );
await page.screenshot( { path: `${shots}/02-grid${trackId ? '-' + trackId : ''}.png` } );
// drive deterministically: autopilot + synchronous simulation, then a few real frames
await page.evaluate( ( secs ) => { const g = window.RUSHGEAR; g.autopilot = true; g.simulate( secs ); }, seconds );
await page.waitForTimeout( 1500 );
const telemetry = await page.evaluate( () => { const g = window.RUSHGEAR; const v = g.playerCar?.vehicle; return v ? { paint: g.playerCar.uniforms.color.value.getHexString(), carId: g.playerCar.def.id, cars: g.cars.length, pos1: g.race?.standings[ 0 ]?.name, playerPos: g.race?.entryOf( v ).position, speedKmh: v.speedKmh.toFixed( 1 ), rpm: v.engine.rpm.toFixed( 0 ), gear: v.engine.gear, pos: v.position.toArray().map( ( x ) => x.toFixed( 1 ) ), s: v.proj.s.toFixed( 1 ), lateral: v.proj.lateral.toFixed( 2 ), onGround: v.wheels.map( ( w ) => w.onGround ), damage: v.damage.toFixed( 2 ), fps: g.hud.el.fps.textContent } : null; } );
console.log( 'telemetry:', JSON.stringify( telemetry ) );
await page.screenshot( { path: `${shots}/03-driving${trackId ? '-' + trackId : ''}.png` } );
for ( const extra of args.filter( ( a ) => a.startsWith( 'eval:' ) ) ) console.log( 'eval', await page.evaluate( extra.slice( 5 ) ) );

console.log( `\n${errors.length} console errors, ${warnings.length} warnings` );
for ( const e of errors.slice( 0, 15 ) ) console.log( ' ERR', e.slice( 0, 1200 ) );
for ( const w of [ ...new Set( warnings ) ].slice( 0, 8 ) ) console.log( ' WARN', w.slice( 0, 400 ) );
await browser.close();
await server.close();
process.exit( errors.length ? 1 : 0 );
