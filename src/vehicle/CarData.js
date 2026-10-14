/**
 * Parametric car definitions. Bodies are lofted from `stations` (cross-sections along the
 * length, tail → nose). Every number here is in metres / SI units.
 *
 * station: { z, hw (half width), floor, belt, roof, roofHw (half roof width), round }
 */

export const CARS = [
	{
		id: 'vesper',
		name: 'Vesper GT',
		maker: 'Rush Gear Works',
		class: 'GT',
		description: 'Front-engined grand tourer. Balanced, forgiving, brutal straight-line pace.',
		paint: { color: [ 0.75, 0.04, 0.05 ], flake: 0.6, metallic: 0.65, clearcoat: 1.0 },
		mass: 1480, cgHeight: 0.48, wheelbase: 2.72, trackF: 1.62, trackR: 1.64,
		wheelRadius: 0.345, wheelWidth: 0.3,
		engine: { maxTorque: 620, peakRpm: 5200, redline: 7600, idle: 900, cylinders: 8, power: 'V8' },
		gears: [ 3.4, 2.2, 1.6, 1.25, 1.0, 0.82 ], finalDrive: 3.3, drivetrain: 'RWD',
		tyres: { grip: 1.35, stiffness: 1.0 },
		aero: { cd: 0.33, area: 2.1, downforce: 1.2, balance: 0.42 },
		suspension: { k: 42000, c: 4200, travel: 0.16, rest: 0.26, arbF: 12000, arbR: 9000 },
		brakes: { maxTorque: 3800, bias: 0.62 },
		steerMax: 0.55,
		stations: [
			{ z: - 2.30, hw: 0.78, floor: 0.42, belt: 0.74, roof: 0.78, roofHw: 0.55, round: 0.25 },
			{ z: - 2.10, hw: 0.90, floor: 0.30, belt: 0.86, roof: 0.92, roofHw: 0.62, round: 0.3 },
			{ z: - 1.40, hw: 0.96, floor: 0.22, belt: 0.90, roof: 1.08, roofHw: 0.62, round: 0.3 },
			{ z: - 0.80, hw: 0.97, floor: 0.20, belt: 0.90, roof: 1.30, roofHw: 0.60, round: 0.3 },
			{ z: - 0.10, hw: 0.97, floor: 0.20, belt: 0.90, roof: 1.32, roofHw: 0.58, round: 0.3 },
			{ z: 0.60, hw: 0.96, floor: 0.20, belt: 0.88, roof: 1.18, roofHw: 0.56, round: 0.3 },
			{ z: 1.10, hw: 0.95, floor: 0.22, belt: 0.84, roof: 0.92, roofHw: 0.56, round: 0.3 },
			{ z: 1.90, hw: 0.92, floor: 0.26, belt: 0.76, roof: 0.80, roofHw: 0.55, round: 0.3 },
			{ z: 2.35, hw: 0.84, floor: 0.34, belt: 0.64, roof: 0.66, roofHw: 0.5, round: 0.3 },
			{ z: 2.48, hw: 0.70, floor: 0.40, belt: 0.56, roof: 0.57, roofHw: 0.4, round: 0.2 }
		],
		cabin: { start: - 1.3, end: 1.0 }, doors: [ - 1.25, 0.45 ], hoodLine: 1.05, trunkLine: - 1.55,
		spoiler: { type: 'lip', height: 0.08 },
		lights: { head: 'oval', tail: 'bar' },
		exhaust: 'twin',
		wheels: { front: 2.72 * 0.5, rear: - 2.72 * 0.5, axleOffset: - 0.15 }
	}
];

export function getCar( id ) { return CARS.find( ( c ) => c.id === id ) || CARS[ 0 ]; }
