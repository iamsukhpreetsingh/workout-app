// foodSeed.js — starter GLOBAL food database (Phase 2).
//
// Scope philosophy (per the rebuild spec): consumer databases (incl. Open
// Food Facts) are strongest on PACKAGED/branded products and weakest on RAW
// INGREDIENTS used in home cooking in every cuisine. This seed therefore
// focuses on genuinely global raw staples — grains, legumes, proteins,
// dairy, oils/fats, vegetables, fruits — plus common prepared basics, so a
// home cook in any country can build real dishes from day one. Coverage
// then grows organically: every Open Food Facts lookup is cached into
// global_foods (verified=false), and admins expand/verify via the Foods
// module. cuisine_tags are pure searchability metadata, never a restriction.
//
// Values are from USDA FoodData Central (rounded) — per 100 g/ml unless the
// item's unit is 'piece', where values are per single piece.
//
// Tuple format: [name, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g,
//                sodium_mg, default_serving_size, default_serving_unit, cuisine_tags]
// Macros: per 100 g/ml (or per piece when unit === 'piece').

const T = (...rows) =>
  rows.map(([name, cal, p, c, f, fiber, sugar, sodium, size, unit, tags]) => ({
    name,
    calories: cal,
    protein_g: p,
    carbs_g: c,
    fat_g: f,
    fiber_g: fiber,
    sugar_g: sugar,
    sodium_mg: sodium,
    default_serving_size: size,
    default_serving_unit: unit,
    source: 'seed',
    verified: true,
    cuisine_tags: tags || [],
  }));

module.exports.FOOD_SEED = [  // ── Grains & grain products ─────────────────────────────────────────────
  T(
    ['White rice, uncooked', 365, 7.1, 80, 0.7, 1.3, 0.1, 5, 100, 'g', ['east_asian', 'indian']],
    ['White rice, cooked', 130, 2.7, 28, 0.3, 0.4, 0.1, 1, 100, 'g', ['east_asian', 'indian']],
    ['Brown rice, cooked', 123, 2.7, 26, 1.0, 1.6, 0.2, 4, 100, 'g', ['indian']],
    ['Basmati rice, cooked', 121, 3.5, 25, 0.4, 0.6, 0.1, 2, 100, 'g', ['indian', 'mediterranean']],
    ['Jasmine rice, cooked', 129, 2.8, 28, 0.3, 0.5, 0.1, 2, 100, 'g', ['east_asian']],
    ['Wheat flour (atta), whole wheat', 340, 13, 72, 2.5, 10.7, 0.5, 2, 100, 'g', ['indian', 'mediterranean']],
    ['All-purpose flour (maida)', 364, 10, 76, 1.0, 2.7, 0.3, 2, 100, 'g', []],
    ['Roti / chapati, plain', 120, 4.0, 18, 3.5, 2.0, 0.2, 80, 1, 'piece', ['indian']],
    ['Bread, white', 265, 9, 49, 3.2, 2.7, 5, 490, 1, 'slice', []],
    ['Bread, whole wheat', 254, 13, 43, 3.5, 6, 5.6, 450, 1, 'slice', []],
    ['Oats, dry rolled', 389, 16.9, 66, 6.9, 10.6, 1, 2, 40, 'g', ['mediterranean']],
    ['Oats, cooked porridge', 71, 2.5, 12, 1.5, 1.7, 0.3, 4, 100, 'g', []],
    ['Quinoa, cooked', 120, 4.4, 21, 1.9, 2.8, 0.9, 7, 100, 'g', ['mediterranean']],
    ['Couscous, cooked', 112, 3.8, 23, 0.2, 1.4, 0.1, 5, 100, 'g', ['mediterranean']],
    ['Semolina (suji/rava)', 360, 12.7, 73, 1.1, 3.9, 0.3, 5, 100, 'g', ['indian', 'mediterranean']],
    ['Pasta, cooked', 158, 5.8, 31, 0.9, 1.8, 0.6, 1, 100, 'g', ['mediterranean']],
    ['Noodles, egg, cooked', 138, 4.5, 24, 3.3, 1.2, 0.4, 5, 100, 'g', ['east_asian']],
    ['Corn tortilla', 58, 1.5, 12, 0.8, 1.7, 0.2, 12, 1, 'piece', ['mexican']],
    ['Pita bread', 165, 5.4, 33, 0.7, 1.3, 0.8, 320, 1, 'piece', ['mediterranean']],
    ['Idli, plain', 58, 2.0, 12, 0.1, 0.5, 0.1, 50, 1, 'piece', ['indian']],
    ['Plain dosa', 130, 3.0, 22, 3.0, 1.0, 0.4, 150, 1, 'piece', ['indian']],

    // ── Legumes / lentils / beans ─────────────────────────────────────────
    ['Toor dal (pigeon pea), dry', 343, 22, 62, 1.5, 15, 1.2, 17, 100, 'g', ['indian']],
    ['Moong dal (mung bean), dry', 347, 24, 63, 1.2, 16, 1.5, 15, 100, 'g', ['indian', 'east_asian']],
    ['Chana dal (split chickpea), dry', 360, 21, 60, 5.6, 17, 3.0, 15, 100, 'g', ['indian']],
    ['Urad dal (black gram), dry', 341, 25, 59, 1.6, 18, 1.0, 20, 100, 'g', ['indian']],
    ['Masoor dal (red lentil), dry', 352, 25, 60, 1.1, 14, 1.8, 10, 100, 'g', ['indian', 'mediterranean']],
    ['Rajma (kidney beans), dry', 333, 24, 60, 0.8, 25, 2.2, 24, 100, 'g', ['indian', 'mexican']],
    ['Chickpeas, cooked', 164, 8.9, 27, 2.6, 7.6, 4.8, 7, 100, 'g', ['mediterranean', 'indian']],
    ['Black beans, cooked', 132, 8.9, 24, 0.5, 8.7, 0.3, 1, 100, 'g', ['mexican']],
    ['Lentils, cooked', 116, 9.0, 20, 0.4, 7.9, 1.8, 2, 100, 'g', []],
    ['Tofu, firm', 144, 17, 3, 8.7, 2.3, 0.6, 14, 100, 'g', ['east_asian']],
    ['Green peas, cooked', 84, 5.4, 16, 0.2, 5.5, 6.0, 3, 100, 'g', ['indian']],
    ['Peanuts, raw', 567, 26, 16, 49, 8.5, 4.2, 18, 28, 'g', ['indian']],

  ),
    // ── Protein: meat / fish / eggs ───────────────────────────────────────
  T(
    ['Chicken breast, skinless, cooked', 165, 31, 0, 3.6, 0, 0, 74, 100, 'g', []],
    ['Chicken thigh, cooked', 209, 26, 0, 11, 0, 0, 88, 100, 'g', []],
    ['Chicken, whole, roasted', 239, 27, 0, 14, 0, 0, 82, 100, 'g', []],
    ['Ground beef, 85% lean, cooked', 250, 26, 0, 15, 0, 0, 66, 100, 'g', []],
    ['Beef steak, cooked', 271, 26, 0, 18, 0, 0, 58, 100, 'g', []],
    ['Pork loin, cooked', 242, 27, 0, 14, 0, 0, 62, 100, 'g', []],
    ['Bacon, cooked', 43, 3.0, 0.1, 3.3, 0, 0, 137, 1, 'slice', []],
    ['Egg, whole, boiled', 155, 13, 1.1, 11, 0, 1.1, 124, 1, 'piece', []],
    ['Egg white, one large', 17, 3.6, 0.2, 0.1, 0, 0.2, 55, 1, 'piece', []],
    ['Salmon, cooked', 208, 20, 0, 13, 0, 0, 59, 100, 'g', []],
    ['Tuna, canned in water', 116, 26, 0, 0.8, 0, 0, 247, 100, 'g', []],
    ['White fish (cod), cooked', 105, 23, 0, 0.9, 0, 0, 78, 100, 'g', []],
    ['Shrimp, cooked', 99, 24, 0.2, 0.3, 0, 0, 111, 100, 'g', []],
    ['Sardines, canned', 208, 25, 0, 11, 0, 0, 505, 100, 'g', []],
    ['Mackerel, cooked', 205, 19, 0, 14, 0, 0, 90, 100, 'g', []],

  ),
    // ── Dairy & alternatives ──────────────────────────────────────────────
  T(
    ['Milk, whole', 61, 3.2, 4.8, 3.3, 0, 5.1, 43, 100, 'ml', []],
    ['Milk, toned (2%)', 50, 3.3, 4.9, 1.9, 0, 5.1, 44, 100, 'ml', ['indian']],
    ['Curd / plain yogurt, whole', 61, 3.5, 4.7, 3.3, 0, 4.7, 46, 100, 'g', ['indian']],
    ['Greek yogurt, plain', 59, 10, 3.6, 0.4, 0, 3.2, 36, 100, 'g', ['mediterranean']],
    ['Paneer (fresh cheese)', 265, 18, 3.6, 20, 0, 2.6, 18, 100, 'g', ['indian']],
    ['Cheddar cheese', 403, 25, 1.3, 33, 0, 0.5, 653, 30, 'g', []],
    ['Mozzarella cheese', 300, 22, 2.2, 22, 0, 1.0, 627, 30, 'g', ['mediterranean']],
    ['Butter', 102, 0.1, 0, 11.5, 0, 0, 91, 1, 'tbsp', []],
    ['Ghee (clarified butter)', 123, 0, 0, 13.9, 0, 0, 0, 1, 'tbsp', ['indian', 'mediterranean']],
    ['Cream, heavy whipping', 51, 0.3, 0.4, 5.4, 0, 0.4, 4, 1, 'tbsp', []],
    ['Cream cheese', 50, 0.9, 0.6, 5.0, 0, 0.5, 47, 1, 'tbsp', []],

  ),
    // ── Oils & fats ───────────────────────────────────────────────────────
  T(
    ['Olive oil', 119, 0, 0, 13.5, 0, 0, 0, 1, 'tbsp', ['mediterranean']],
    ['Vegetable oil (soybean/canola)', 120, 0, 0, 13.6, 0, 0, 0, 1, 'tbsp', []],
    ['Coconut oil', 121, 0, 0, 13.6, 0, 0, 0, 1, 'tbsp', ['indian', 'east_asian']],
    ['Mustard oil', 120, 0, 0, 13.6, 0, 0, 0, 1, 'tbsp', ['indian']],
    ['Groundnut oil (peanut oil)', 119, 0, 0, 13.5, 0, 0, 0, 1, 'tbsp', ['indian']],
    ['Sesame oil', 120, 0, 0, 13.6, 0, 0, 0, 1, 'tbsp', ['east_asian', 'indian']],
    ['Mayonnaise', 94, 0.1, 0.1, 10, 0, 0.1, 88, 1, 'tbsp', []],

  ),
    // ── Vegetables ────────────────────────────────────────────────────────
  T(
    ['Onion, raw', 40, 1.1, 9.3, 0.1, 1.7, 4.2, 4, 100, 'g', ['indian', 'mediterranean']],
    ['Tomato, raw', 18, 0.9, 3.9, 0.2, 1.2, 2.6, 5, 100, 'g', ['indian', 'mediterranean']],
    ['Potato, boiled', 87, 1.9, 20, 0.1, 1.8, 0.9, 4, 100, 'g', ['indian', 'mediterranean']],
    ['Potato, baked, with skin', 93, 2.5, 21, 0.1, 2.2, 1.2, 10, 100, 'g', []],
    ['Spinach (palak), raw', 23, 2.9, 3.6, 0.4, 2.2, 0.4, 79, 100, 'g', ['indian', 'mediterranean']],
    ['Cauliflower, raw', 25, 1.9, 5.0, 0.3, 2.0, 1.9, 30, 100, 'g', ['indian']],
    ['Okra (bhindi), raw', 33, 1.9, 7.5, 0.2, 3.2, 1.5, 8, 100, 'g', ['indian']],
    ['Carrot, raw', 41, 0.9, 9.6, 0.2, 2.8, 4.7, 69, 100, 'g', []],
    ['Cabbage, raw', 25, 1.3, 5.8, 0.1, 2.5, 3.2, 18, 100, 'g', ['indian', 'east_asian']],
    ['Broccoli, raw', 34, 2.8, 6.6, 0.4, 2.6, 1.7, 33, 100, 'g', ['mediterranean']],
    ['Cucumber, raw', 15, 0.7, 3.6, 0.1, 0.5, 1.7, 2, 100, 'g', ['indian', 'mediterranean']],
    ['Bell pepper, raw', 26, 1.0, 6.0, 0.3, 2.1, 4.2, 3, 100, 'g', ['mediterranean', 'mexican']],
    ['Eggplant (brinjal), raw', 25, 1.0, 5.9, 0.2, 3.0, 3.5, 2, 100, 'g', ['indian', 'mediterranean']],
    ['Green beans, cooked', 35, 1.9, 7.9, 0.1, 3.2, 1.5, 1, 100, 'g', []],
    ['Pumpkin, raw', 26, 1.0, 6.5, 0.1, 0.5, 2.8, 1, 100, 'g', ['indian']],
    ['Radish (mooli), raw', 16, 0.7, 3.4, 0.1, 1.6, 1.9, 39, 100, 'g', ['indian', 'east_asian']],
    ['Beetroot, raw', 43, 1.6, 9.6, 0.2, 2.8, 6.8, 78, 100, 'g', ['indian', 'mediterranean']],
    ['Sweet potato, boiled', 76, 1.4, 18, 0.1, 2.5, 6.5, 36, 100, 'g', []],
    ['Peas, green, raw', 81, 5.4, 14, 0.4, 5.7, 5.7, 4, 100, 'g', ['indian']],
    ['Bitter gourd (karela), raw', 17, 0.9, 4.3, 0.2, 2.6, 1.1, 5, 100, 'g', ['indian']],
    ['Bottle gourd (lauki), raw', 14, 0.6, 3.4, 0.02, 1.2, 1.4, 2, 100, 'g', ['indian']],
    ['Zucchini, raw', 17, 1.2, 3.1, 0.3, 1.0, 2.5, 8, 100, 'g', ['mediterranean']],
    ['Mushrooms, white, raw', 22, 3.1, 3.3, 0.3, 1.0, 2.0, 5, 100, 'g', []],
    ['Lettuce, raw', 15, 1.4, 2.9, 0.2, 1.3, 0.8, 28, 100, 'g', []],

  ),
    // ── Fruits ────────────────────────────────────────────────────────────
  T(
    ['Banana, raw', 89, 1.1, 23, 0.3, 2.6, 12, 1, 1, 'piece', []],
    ['Apple, raw, with skin', 52, 0.3, 14, 0.2, 2.4, 10, 1, 1, 'piece', []],
    ['Orange, raw', 47, 0.9, 12, 0.1, 2.4, 9.4, 0, 1, 'piece', []],
    ['Mango, raw', 60, 0.8, 15, 0.4, 1.6, 14, 1, 100, 'g', ['indian']],
    ['Papaya, raw', 43, 0.5, 11, 0.3, 1.7, 7.8, 8, 100, 'g', ['indian']],
    ['Grapes, raw', 69, 0.7, 18, 0.2, 0.9, 16, 2, 100, 'g', []],
    ['Watermelon, raw', 30, 0.6, 7.6, 0.2, 0.4, 6.2, 1, 100, 'g', []],
    ['Strawberries, raw', 32, 0.7, 7.7, 0.3, 2.0, 4.9, 1, 100, 'g', []],
    ['Guava, raw', 68, 2.6, 14, 1.0, 5.4, 9.0, 2, 1, 'piece', ['indian']],
    ['Pomegranate, raw', 83, 1.7, 19, 1.2, 4.0, 14, 3, 100, 'g', ['indian', 'mediterranean']],
    ['Pineapple, raw', 50, 0.5, 13, 0.1, 1.4, 9.9, 1, 100, 'g', []],
    ['Avocado, raw', 160, 2.0, 8.5, 15, 6.7, 0.7, 7, 100, 'g', ['mediterranean', 'mexican']],
    ['Dates, dried', 23, 0.2, 6.0, 0, 0.6, 5.0, 0, 1, 'piece', ['indian', 'mediterranean']],
    ['Raisins', 299, 3.1, 79, 0.5, 3.7, 59, 11, 28, 'g', []],
    ['Lemon, raw', 29, 1.1, 9.3, 0.3, 2.8, 2.5, 2, 1, 'piece', ['indian', 'mediterranean']],

  ),
    // ── Nuts & seeds ──────────────────────────────────────────────────────
  T(
    ['Almonds', 579, 21, 22, 50, 12.5, 4.4, 1, 28, 'g', ['indian', 'mediterranean']],
    ['Walnuts', 654, 15, 14, 65, 6.7, 2.6, 2, 28, 'g', ['mediterranean']],
    ['Cashews', 553, 18, 30, 44, 3.3, 5.9, 12, 28, 'g', ['indian']],
    ['Pistachios', 560, 20, 28, 45, 10.6, 7.7, 1, 28, 'g', ['mediterranean', 'indian']],
    ['Chia seeds', 486, 17, 42, 31, 34, 0, 16, 15, 'g', []],
    ['Flaxseeds', 534, 18, 29, 42, 27, 1.6, 30, 15, 'g', []],
    ['Sesame seeds', 573, 18, 23, 50, 11.8, 0.3, 11, 15, 'g', ['indian', 'east_asian']],
    ['Pumpkin seeds', 559, 30, 11, 49, 6.0, 1.4, 7, 28, 'g', ['mediterranean']],

  ),
    // ── Spices & flavor bases (low-impact, for real recipe building) ─────
  T(
    ['Turmeric powder', 8, 0.2, 1.4, 0.2, 0.5, 0.1, 0, 1, 'tsp', ['indian']],
    ['Cumin seeds', 8, 0.4, 0.9, 0.5, 0.2, 0, 2, 1, 'tsp', ['indian', 'mediterranean']],
    ['Garam masala', 8, 0.3, 1.0, 0.3, 0.5, 0, 1, 1, 'tsp', ['indian']],
    ['Coriander powder', 6, 0.2, 1.1, 0.3, 0.6, 0, 0, 1, 'tsp', ['indian', 'mediterranean']],
    ['Red chili powder', 8, 0.4, 1.3, 0.4, 0.7, 0.2, 1, 1, 'tsp', ['indian', 'mexican']],
    ['Mustard seeds', 10, 0.5, 0.6, 0.7, 0.2, 0.1, 0, 1, 'tsp', ['indian']],
    ['Ginger, raw', 5, 0.1, 1.1, 0, 0.1, 0.1, 0, 1, 'tbsp', ['indian', 'east_asian']],
    ['Garlic, raw', 4, 0.2, 0.9, 0, 0.1, 0, 1, 1, 'clove', ['indian', 'mediterranean', 'east_asian']],
    ['Green chili, raw', 40, 1.9, 9.5, 0.4, 1.5, 5.3, 7, 1, 'piece', ['indian', 'mexican']],
    ['Soy sauce', 8, 1.3, 0.8, 0.1, 0.1, 0.1, 878, 1, 'tbsp', ['east_asian']],

  ),
    // ── Common prepared / packaged basics ────────────────────────────────
  T(
    ['Sugar, white', 16, 0, 4.2, 0, 0, 4.2, 0, 1, 'tsp', []],
    ['Honey', 64, 0.1, 17, 0, 0, 17, 1, 1, 'tbsp', []],
    ['Salt', 0, 0, 0, 0, 0, 0, 38758, 1, 'tsp', []],
    ['Peanut butter', 94, 4.0, 3.2, 8.0, 0.9, 1.5, 73, 1, 'tbsp', []],
    ['Jam / fruit preserve', 56, 0.1, 14, 0, 0.2, 10, 4, 1, 'tbsp', []],
    ['Chocolate, milk', 535, 7.6, 59, 30, 3.4, 52, 79, 100, 'g', []],
    ['Biscuits, plain', 48, 0.7, 6.5, 2.0, 0.2, 2.0, 35, 1, 'piece', ['indian']],
    ['Potato chips', 536, 7, 53, 34, 4.4, 0.3, 525, 28, 'g', []],
    ['Popcorn, air-popped', 387, 13, 78, 4.5, 15, 0.9, 8, 28, 'g', []],
    ['Coffee, black, no sugar', 1, 0.1, 0, 0, 0, 0, 2, 1, 'cup', []],
    ['Tea with milk, unsweetened', 30, 1.5, 2.5, 1.4, 0, 2.5, 20, 1, 'cup', ['indian']],
    ['Orange juice', 45, 0.7, 10, 0.2, 0.2, 8.4, 1, 100, 'ml', []],
    ['Cola, soft drink', 41, 0, 11, 0, 0, 11, 4, 100, 'ml', []],
    ['Protein shake, whey in water', 120, 24, 3.0, 1.5, 0, 1.0, 60, 1, 'scoop', []],
  ),
].flat();
