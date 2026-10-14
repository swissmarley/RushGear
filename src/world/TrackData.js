/**
 * Track definitions. Each track is a closed Catmull-Rom spline through control points
 * [x, z, elevation, bank(deg), width(m)]. Corners/tunnels reference control-point indices.
 * Everything else (meshes, racing line, scenery) is derived procedurally from this data.
 */

export const TRACKS = [
	{
		id: 'azure',
		name: 'Azure Coast',
		location: 'Riviera, coastal day',
		biome: 'coastal',
		timeOfDay: 10.5,       // hours
		dayRate: 1 / 240,      // game-hours per real second (slow, sunny day drifts toward afternoon)
		weather: { rain: 0, cloud: 0.25, temperature: 26 },
		laps: 3,
		autoBank: 0.9,
		runoff: 'grass', runoffWidth: 7, barrier: 'armco',
		seaLevel: - 4,
		points: [
			[ - 250, - 300, 2, 0, 15 ], [ - 50, - 300, 3, 0, 15 ], [ 150, - 300, 4, 0, 15 ], [ 300, - 290, 5, 0, 14 ],
			[ 400, - 240, 8, 0, 14 ], [ 450, - 150, 12, 0, 14 ], [ 440, - 60, 16, 0, 14 ],
			[ 380, 20, 20, 0, 13 ], [ 300, 60, 22, 0, 13 ],
			[ 220, 140, 26, 0, 13 ], [ 230, 240, 30, 0, 13 ], [ 310, 300, 32, 0, 13 ],
			[ 420, 330, 36, 0, 13 ], [ 500, 400, 40, 0, 13 ], [ 520, 500, 42, 0, 13 ], [ 460, 560, 44, 0, 13 ],
			[ 360, 540, 40, 0, 13 ], [ 280, 480, 36, 0, 13 ], [ 180, 470, 32, 0, 13 ],
			[ 80, 520, 28, 0, 13 ], [ - 40, 560, 24, 0, 13 ], [ - 160, 540, 20, 0, 13 ],
			[ - 260, 470, 16, 0, 13 ], [ - 300, 360, 12, 0, 14 ], [ - 380, 300, 10, 0, 14 ], [ - 470, 230, 8, 0, 14 ],
			[ - 520, 120, 6, 0, 14 ], [ - 540, 0, 4, 0, 14 ], [ - 520, - 120, 3, 0, 15 ], [ - 500, - 220, 2, 0, 15 ], [ - 450, - 300, 2, 0, 15 ]
		],
		corners: [
			{ name: 'Marina Sweep', from: 4, to: 7 },
			{ name: 'Cliff Climb', from: 9, to: 11 },
			{ name: 'Lighthouse Hairpin', from: 13, to: 16 },
			{ name: 'Tunnel Esses', from: 18, to: 21 },
			{ name: 'Seaview', from: 22, to: 25 },
			{ name: 'Harbour Curve', from: 26, to: 30 }
		],
		tunnels: [ { from: 16, to: 18 } ]
	}
];

export function getTrack( id ) { return TRACKS.find( ( t ) => t.id === id ) || TRACKS[ 0 ]; }
