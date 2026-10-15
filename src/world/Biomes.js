/**
 * Biome palettes & parameters. Colours are linear-space RGB arrays.
 * Each biome drives: terrain shape, ground palette, sky/fog tint, scenery recipe, grading.
 */
export const BIOMES = {
	coastal: {
		name: 'Coastal',
		terrain: { amp: 18, freq: 0.004, ridge: 40, bowl: 60 },
		ground: { grass: [ 0.16, 0.30, 0.08 ], dirt: [ 0.32, 0.25, 0.15 ], rock: [ 0.42, 0.40, 0.36 ], sand: [ 0.68, 0.60, 0.42 ] },
		runoff: [ 0.16, 0.30, 0.08 ],
		fog: { density: 0.0007, height: 60, color: [ 0.62, 0.72, 0.85 ] },
		sea: true,
		scenery: 'coastal',
		grade: { lift: [ 0.0, 0.0, 0.01 ], gamma: [ 1, 1, 1 ], gain: [ 1.03, 1.0, 0.97 ], saturation: 1.1, contrast: 1.05 }
	},
	mountain: {
		name: 'Mountain',
		terrain: { amp: 35, freq: 0.0035, ridge: 160, bowl: 180 },
		ground: { grass: [ 0.14, 0.24, 0.08 ], dirt: [ 0.28, 0.22, 0.14 ], rock: [ 0.36, 0.34, 0.33 ], sand: [ 0.5, 0.45, 0.4 ] },
		runoff: [ 0.14, 0.24, 0.08 ],
		fog: { density: 0.0012, height: 90, color: [ 0.55, 0.5, 0.62 ] },
		scenery: 'mountain',
		grade: { lift: [ 0.0, 0.0, 0.02 ], gamma: [ 1, 1, 1 ], gain: [ 1.0, 0.95, 1.05 ], saturation: 1.05, contrast: 1.08 }
	},
	desert: {
		name: 'Desert',
		terrain: { amp: 14, freq: 0.003, ridge: 70, bowl: 40 },
		ground: { grass: [ 0.55, 0.42, 0.22 ], dirt: [ 0.62, 0.45, 0.25 ], rock: [ 0.5, 0.32, 0.2 ], sand: [ 0.78, 0.62, 0.38 ] },
		runoff: [ 0.72, 0.58, 0.36 ],
		fog: { density: 0.0005, height: 40, color: [ 0.9, 0.62, 0.42 ] },
		scenery: 'desert',
		heat: 1,
		grade: { lift: [ 0.005, 0.0, 0.0 ], gamma: [ 1, 1, 1 ], gain: [ 1.03, 0.99, 0.94 ], saturation: 1.08, contrast: 1.05 }
	},
	forest: {
		name: 'Forest',
		terrain: { amp: 22, freq: 0.004, ridge: 50, bowl: 90 },
		ground: { grass: [ 0.08, 0.18, 0.05 ], dirt: [ 0.2, 0.15, 0.09 ], rock: [ 0.28, 0.28, 0.26 ], sand: [ 0.3, 0.26, 0.2 ] },
		runoff: [ 0.10, 0.20, 0.06 ],
		fog: { density: 0.0022, height: 70, color: [ 0.45, 0.5, 0.52 ] },
		scenery: 'forest',
		grade: { lift: [ 0.0, 0.01, 0.01 ], gamma: [ 1, 1, 1 ], gain: [ 0.92, 1.0, 1.0 ], saturation: 0.95, contrast: 1.05 }
	},
	city: {
		name: 'City',
		terrain: { amp: 0.5, freq: 0.01, ridge: 0, bowl: 0 },
		ground: { grass: [ 0.08, 0.08, 0.09 ], dirt: [ 0.1, 0.1, 0.1 ], rock: [ 0.12, 0.12, 0.13 ], sand: [ 0.12, 0.12, 0.13 ] },
		runoff: [ 0.14, 0.14, 0.15 ],
		fog: { density: 0.0016, height: 50, color: [ 0.12, 0.1, 0.2 ] },
		scenery: 'city',
		grade: { lift: [ 0.0, 0.0, 0.02 ], gamma: [ 1, 1, 1 ], gain: [ 1.0, 0.97, 1.06 ], saturation: 1.15, contrast: 1.08 }
	},
	oval: {
		name: 'Speedway',
		terrain: { amp: 3, freq: 0.004, ridge: 0, bowl: 20 },
		ground: { grass: [ 0.18, 0.32, 0.09 ], dirt: [ 0.35, 0.28, 0.18 ], rock: [ 0.4, 0.38, 0.35 ], sand: [ 0.6, 0.55, 0.42 ] },
		runoff: [ 0.18, 0.32, 0.09 ],
		fog: { density: 0.0005, height: 50, color: [ 0.7, 0.78, 0.9 ] },
		scenery: 'oval',
		grade: { lift: [ 0.0, 0.0, 0.0 ], gamma: [ 1, 1, 1 ], gain: [ 1.02, 1.0, 1.0 ], saturation: 1.1, contrast: 1.06 }
	}
};
