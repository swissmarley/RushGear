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
	},
	{
		id: 'alpine',
		name: 'Alpine Pass',
		location: 'High mountains, dusk',
		biome: 'mountain',
		timeOfDay: 18.6,
		dayRate: 1 / 140,
		weather: { rain: 0, cloud: 0.5, temperature: 8 },
		laps: 3,
		autoBank: 0.6,
		runoff: 'gravel', runoffWidth: 5, barrier: 'armco',
		points: [
			[ 0, - 350, 12, 0, 13 ], [ 0, - 200, 16, 0, 13 ],
			[ 40, - 120, 22, 0, 13 ], [ 130, - 100, 30, 0, 12 ], [ 260, - 100, 38, 0, 12 ], [ 390, - 100, 46, 0, 12 ],
			[ 470, - 70, 52, 0, 12 ], [ 480, 20, 58, 0, 12 ], [ 400, 50, 62, 0, 12 ],
			[ 280, 50, 66, 0, 12 ], [ 160, 50, 72, 0, 12 ], [ 60, 60, 78, 0, 12 ],
			[ - 30, 100, 84, 0, 12 ], [ - 20, 190, 90, 0, 12 ], [ 70, 220, 94, 0, 12 ],
			[ 200, 230, 98, 0, 12 ], [ 330, 240, 102, 0, 12 ], [ 440, 270, 104, 0, 12 ],
			[ 500, 360, 102, 0, 12 ], [ 450, 450, 98, 0, 12 ], [ 320, 480, 94, 0, 12 ], [ 180, 470, 90, 0, 12 ],
			[ 50, 480, 84, 0, 12 ], [ - 90, 470, 76, 0, 12 ], [ - 220, 430, 66, 0, 12 ], [ - 330, 360, 56, 0, 12 ],
			[ - 400, 250, 46, 0, 13 ], [ - 430, 120, 36, 0, 13 ], [ - 420, - 20, 28, 0, 13 ], [ - 380, - 150, 22, 0, 13 ],
			[ - 320, - 280, 16, 0, 13 ], [ - 260, - 400, 12, 0, 13 ], [ - 170, - 480, 10, 0, 13 ], [ - 70, - 510, 10, 0, 13 ], [ 0, - 500, 10, 0, 13 ]
		],
		corners: [
			{ name: 'Gorge Turn', from: 2, to: 4 },
			{ name: 'Eagle Hairpin', from: 6, to: 9 },
			{ name: 'Switchback', from: 12, to: 15 },
			{ name: 'Summit', from: 17, to: 20 },
			{ name: 'Glacier Esses', from: 22, to: 25 },
			{ name: 'Valley Sweep', from: 26, to: 29 },
			{ name: 'Last Chance', from: 31, to: 34 }
		],
		tunnels: [ { from: 18, to: 20 } ]
	},
	{
		id: 'mesa',
		name: 'Mesa Verde',
		location: 'High desert, sunset',
		biome: 'desert',
		timeOfDay: 19.2,
		dayRate: 1 / 160,
		weather: { rain: 0, cloud: 0.15, temperature: 38 },
		laps: 3,
		autoBank: 1.3,
		runoff: 'sand', runoffWidth: 8, barrier: 'armco',
		points: [
			[ - 500, - 200, 4, 0, 15 ], [ - 300, - 220, 5, 0, 15 ], [ - 100, - 240, 6, 0, 15 ], [ 100, - 250, 7, 0, 15 ], [ 300, - 240, 8, 0, 15 ],
			[ 460, - 190, 10, 0, 15 ], [ 560, - 80, 12, 0, 15 ], [ 580, 60, 14, 0, 15 ],
			[ 520, 180, 16, 0, 14 ], [ 400, 240, 18, 0, 14 ], [ 280, 220, 20, 0, 14 ],
			[ 200, 140, 22, 0, 14 ], [ 110, 100, 24, 0, 14 ], [ 0, 130, 26, 0, 14 ],
			[ - 80, 220, 24, 0, 14 ], [ - 120, 340, 20, 0, 14 ], [ - 220, 400, 16, 0, 14 ], [ - 340, 380, 12, 0, 14 ],
			[ - 420, 300, 10, 0, 15 ], [ - 470, 200, 8, 0, 15 ], [ - 560, 120, 6, 0, 15 ], [ - 600, 0, 4, 0, 15 ], [ - 580, - 120, 4, 0, 15 ]
		],
		corners: [
			{ name: 'Canyon Bend', from: 4, to: 7 },
			{ name: 'Rattlesnake', from: 8, to: 10 },
			{ name: 'Mesa Hook', from: 11, to: 13 },
			{ name: 'Dune Sweep', from: 14, to: 17 },
			{ name: 'Sundown Curve', from: 18, to: 22 }
		],
		tunnels: []
	},
	{
		id: 'blackwood',
		name: 'Blackwood',
		location: 'Deep forest, rain',
		biome: 'forest',
		timeOfDay: 14.0,
		dayRate: 1 / 300,
		weather: { rain: 0.85, cloud: 0.95, temperature: 12 },
		laps: 3,
		autoBank: 0.5,
		runoff: 'grass', runoffWidth: 4, barrier: 'armco',
		points: [
			[ - 350, - 300, 20, 0, 12 ], [ - 180, - 320, 22, 0, 12 ], [ - 20, - 330, 24, 0, 12 ],
			[ 120, - 300, 28, 0, 12 ], [ 200, - 220, 32, 0, 11 ], [ 190, - 120, 36, 0, 11 ],
			[ 120, - 60, 38, 0, 11 ], [ 140, 40, 40, 0, 11 ], [ 230, 90, 42, 0, 11 ], [ 330, 60, 44, 0, 11 ],
			[ 400, 120, 46, 0, 11 ], [ 390, 230, 44, 0, 11 ], [ 300, 300, 40, 0, 11 ], [ 180, 290, 36, 0, 11 ],
			[ 90, 340, 32, 0, 11 ], [ - 20, 380, 28, 0, 11 ], [ - 140, 340, 24, 0, 11 ], [ - 200, 240, 22, 0, 11 ],
			[ - 300, 200, 20, 0, 12 ], [ - 400, 230, 18, 0, 12 ], [ - 470, 150, 16, 0, 12 ], [ - 440, 40, 16, 0, 12 ],
			[ - 360, - 20, 18, 0, 12 ], [ - 380, - 120, 18, 0, 12 ], [ - 440, - 200, 18, 0, 12 ], [ - 420, - 280, 19, 0, 12 ]
		],
		corners: [
			{ name: 'Mill Corner', from: 3, to: 5 },
			{ name: 'Fox Hollow', from: 6, to: 9 },
			{ name: 'Timber Loop', from: 10, to: 13 },
			{ name: 'Brook Esses', from: 14, to: 17 },
			{ name: 'Old Oak', from: 19, to: 21 },
			{ name: 'Ridge Chicane', from: 22, to: 25 }
		],
		tunnels: []
	},
	{
		id: 'neon',
		name: 'Neon Harbour',
		location: 'Waterfront street circuit, night',
		biome: 'city',
		timeOfDay: 23.0,
		dayRate: 1 / 600,
		weather: { rain: 0.25, cloud: 0.6, temperature: 18 },
		laps: 3,
		autoBank: 0,
		runoff: 'concrete', runoffWidth: 2.5, barrier: 'concrete',
		points: [
			[ - 300, - 400, 2, 0, 13 ], [ - 100, - 400, 2, 0, 13 ], [ 100, - 400, 2, 0, 13 ], [ 250, - 400, 2, 0, 13 ],
			[ 330, - 390, 2, 0, 13 ], [ 380, - 340, 2, 0, 13 ], [ 390, - 260, 2, 0, 13 ],
			[ 390, - 120, 2, 0, 13 ], [ 380, - 20, 2, 0, 13 ],
			[ 350, 30, 2, 0, 12 ], [ 300, 60, 2, 0, 12 ], [ 280, 120, 2, 0, 12 ],
			[ 300, 220, 2, 0, 13 ], [ 340, 300, 2, 0, 13 ],
			[ 330, 380, 2, 0, 13 ], [ 270, 420, 2, 0, 13 ], [ 180, 420, 2, 0, 13 ],
			[ 0, 430, 2, 0, 14 ], [ - 150, 430, 2, 0, 14 ],
			[ - 260, 420, 2, 0, 13 ], [ - 320, 360, 2, 0, 13 ], [ - 320, 280, 2, 0, 13 ],
			[ - 300, 180, 2, 0, 13 ], [ - 250, 120, 2, 0, 13 ],
			[ - 200, 40, - 2, 0, 13 ], [ - 220, - 60, - 4, 0, 13 ], [ - 300, - 120, 0, 0, 13 ],
			[ - 360, - 180, 2, 0, 13 ], [ - 380, - 260, 2, 0, 13 ], [ - 360, - 340, 2, 0, 13 ], [ - 330, - 390, 2, 0, 13 ]
		],
		corners: [
			{ name: 'Pier Corner', from: 4, to: 6 },
			{ name: 'Market Chicane', from: 9, to: 11 },
			{ name: 'Cathedral Turn', from: 14, to: 16 },
			{ name: 'Harbour Hairpin', from: 19, to: 21 },
			{ name: 'Underpass', from: 24, to: 26 },
			{ name: 'Casino Curve', from: 27, to: 30 }
		],
		tunnels: [ { from: 24, to: 26 } ]
	},
	{
		id: 'thunder',
		name: 'Thunder Bowl',
		location: 'Superspeedway, midday',
		biome: 'oval',
		timeOfDay: 13.0,
		dayRate: 1 / 200,
		weather: { rain: 0, cloud: 0.1, temperature: 30 },
		laps: 8,
		autoBank: 0,
		runoff: 'concrete', runoffWidth: 3, barrier: 'safer',
		points: [
			[ 350, - 180, 0, 0, 18 ], [ 0, - 180, 0, 0, 18 ], [ - 350, - 180, 0, 0, 18 ],
			[ - 480, - 130, 0, 18, 18 ], [ - 530, 0, 0, 26, 18 ], [ - 480, 130, 0, 18, 18 ],
			[ - 350, 180, 0, 0, 18 ], [ 0, 180, 0, 0, 18 ], [ 350, 180, 0, 0, 18 ],
			[ 480, 130, 0, 18, 18 ], [ 530, 0, 0, 26, 18 ], [ 480, - 130, 0, 18, 18 ]
		],
		corners: [
			{ name: 'Turn 1', from: 2, to: 4 }, { name: 'Turn 2', from: 4, to: 6 },
			{ name: 'Turn 3', from: 8, to: 10 }, { name: 'Turn 4', from: 10, to: 0 }
		],
		tunnels: []
	}
];

export function getTrack( id ) { return TRACKS.find( ( t ) => t.id === id ) || TRACKS[ 0 ]; }
