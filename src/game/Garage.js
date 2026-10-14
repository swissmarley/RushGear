/**
 * Garage: a studio scene with a turntable, soft key/fill/rim lighting and a glossy floor
 * for inspecting cars. Also owns the paint overrides chosen by the player.
 */
import { Scene, Group, Mesh, CircleGeometry, PlaneGeometry, DirectionalLight, SpotLight, HemisphereLight, Color, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, BackSide, SphereGeometry, PerspectiveCamera } from 'three/webgpu';
import { vec3, float, positionWorld, length, smoothstep, mix, mx_noise_float, uv, fract, step, oneMinus } from 'three/tsl';
import { CarBuilder } from '../vehicle/CarBuilder.js';
import { getCar } from '../vehicle/CarData.js';
import { Storage } from '../core/Storage.js';
import { makeRNG } from '../core/math.js';

export class Garage {
	constructor( quality ) {
		this.quality = quality;
		this.scene = new Scene();
		this.scene.background = new Color( 0x07080c );
		this.camera = new PerspectiveCamera( 32, 1, 0.1, 100 );
		this.turntable = new Group();
		this.scene.add( this.turntable );
		this.car = null;
		this.carId = null;
		this.paints = Storage.get( 'paints', {} );
		this.angle = 0;
		this._buildStudio();
	}

	_buildStudio() {
		// glossy dark floor with a soft spotlight pool
		const floorMat = new MeshPhysicalNodeMaterial();
		const d = length( positionWorld.xz );
		const pool = smoothstep( 9.0, 2.0, d );
		const grid = step( 0.97, fract( positionWorld.x.mul( 0.5 ) ) ).add( step( 0.97, fract( positionWorld.z.mul( 0.5 ) ) ) ).mul( 0.03 );
		floorMat.colorNode = mix( vec3( 0.012 ), vec3( 0.06 ), pool ).add( grid );
		floorMat.roughnessNode = float( 0.18 ).add( mx_noise_float( positionWorld.mul( 2.0 ) ).mul( 0.05 ) );
		floorMat.metalnessNode = float( 0.1 );
		floorMat.clearcoatNode = float( 1 );
		floorMat.clearcoatRoughnessNode = float( 0.1 );
		const floor = new Mesh( new CircleGeometry( 40, 64 ), floorMat );
		floor.rotation.x = - Math.PI / 2;
		floor.receiveShadow = true;
		this.scene.add( floor );
		// surrounding dome (dark gradient) so reflections have something to show
		const domeMat = new MeshBasicNodeMaterial();
		domeMat.colorNode = mix( vec3( 0.02, 0.022, 0.03 ), vec3( 0.10, 0.11, 0.14 ), smoothstep( - 0.1, 0.9, positionWorld.y.div( 30.0 ) ) );
		domeMat.side = BackSide;
		this.scene.add( new Mesh( new SphereGeometry( 60, 24, 12 ), domeMat ) );
		// softbox light panels (emissive strips) — visible in the paint reflections
		const panelMat = new MeshBasicNodeMaterial(); panelMat.colorNode = vec3( 6.0, 6.0, 6.5 );
		for ( const [ x, y, z, ry ] of [ [ - 8, 6, 4, 0.8 ], [ 8, 7, - 2, - 0.8 ], [ 0, 9, - 8, 0 ] ] ) {
			const p = new Mesh( new PlaneGeometry( 6, 1.2 ), panelMat ); p.position.set( x, y, z ); p.lookAt( 0, 1, 0 ); this.scene.add( p );
		}
		const key = new SpotLight( 0xfff2e0, 600, 40, 0.6, 0.5, 1.5 ); key.position.set( - 6, 8, 5 ); key.castShadow = true; key.shadow.mapSize.set( 2048, 2048 ); key.shadow.bias = - 0.0004; this.scene.add( key ); key.target.position.set( 0, 0.5, 0 ); this.scene.add( key.target );
		const fill = new SpotLight( 0xd0e0ff, 250, 40, 0.8, 0.6, 1.5 ); fill.position.set( 7, 5, - 3 ); this.scene.add( fill ); fill.target.position.set( 0, 0.5, 0 ); this.scene.add( fill.target );
		const rim = new DirectionalLight( 0xffffff, 2.5 ); rim.position.set( 0, 6, - 10 ); this.scene.add( rim );
		this.scene.add( new HemisphereLight( 0x334466, 0x080808, 0.6 ) );
	}

	show( carId ) {
		if ( this.carId === carId && this.car ) return;
		this.hide();
		const def = getCar( carId );
		const built = CarBuilder.build( def, { quality: this.quality } );
		const paint = this.paints[ carId ];
		if ( paint ) built.uniforms.color.value.setRGB( ...paint );
		this.turntable.add( built.group );
		this.car = built; this.carId = carId;
	}

	hide() {
		if ( this.car ) { this.turntable.remove( this.car.group ); this.car = null; this.carId = null; }
	}

	/** Pick a fresh showroom colour (deterministic per click count so it feels designed). */
	repaint() {
		if ( ! this.car ) return;
		const rng = makeRNG( ( Date.now() % 100000 ) | 0 );
		const palette = [ [ 0.75, 0.04, 0.05 ], [ 0.02, 0.1, 0.5 ], [ 0.85, 0.85, 0.88 ], [ 0.02, 0.02, 0.025 ], [ 0.9, 0.5, 0.02 ], [ 0.02, 0.45, 0.2 ], [ 0.5, 0.02, 0.4 ], [ 0.55, 0.55, 0.6 ], [ 0.95, 0.75, 0.05 ], [ 0.02, 0.6, 0.75 ] ];
		const c = rng.pick( palette ).map( ( v ) => Math.min( 1, v * rng.range( 0.85, 1.15 ) ) );
		this.car.uniforms.color.value.setRGB( ...c );
		this.paints[ this.carId ] = c;
		Storage.set( 'paints', this.paints );
	}

	update( dt, time ) {
		this.angle += dt * 0.25;
		this.turntable.rotation.y = this.angle;
		const c = this.camera;
		c.position.set( Math.sin( time * 0.07 ) * 1.5 + 7.0, 1.9 + Math.sin( time * 0.11 ) * 0.3, 6.0 );
		c.lookAt( - 2.2, 0.55, 1.2 );
		if ( this.car ) {
			const u = this.car.uniforms;
			u.head.value = 1; u.brake.value = 0.3;
			for ( const w of this.car.wheels ) w.spin.rotation.x += dt * 0.6;
		}
	}

	resize( aspect ) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
}
