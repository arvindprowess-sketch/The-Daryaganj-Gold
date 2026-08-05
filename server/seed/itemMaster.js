// ═══════════════════════════════════════════════════════════════════════════
// Item master source for the seed.
//
// PREFERRED: the client's real export, dropped in as
//     server/seed/Item_Master_Import_Ready.csv
// with columns: item_name, super_category, category, unit, is_liquor,
//               bottle_size_ml, rate
// When that file is present it is the single source of truth and is used
// verbatim — units included, character for character.
//
// FALLBACK: if the file is absent, a stand-in master is generated at the same
// volume and distribution (618 items: FOOD 299, NON FOOD 128, CCG 70,
// LIQUOR 64, BEVERAGES 57) so the app can be exercised at realistic scale.
// These stand-in names are NOT client data and are clearly announced as such.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvObjects } from '../src/lib/csv.js';
import { HIERARCHY } from './hierarchy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REAL_CSV = path.join(__dirname, 'Item_Master_Import_Ready.csv');

const truthy = (v) => /^(1|true|yes|y)$/i.test(String(v || '').trim());

// Real-world unit strings from the client's master. Free text, never a
// dropdown: they are displayed exactly as written.
const UNITS = [
  'KG', 'GM', 'LTR', 'ML', 'PCS', 'NOS', 'POR', 'PKT', 'BOX', 'DOZ',
  'CAN (5 LTR)', 'BTL (500 ML)', 'TIN (850 GM)', 'BOT-680G', 'Pkt (50 pcs)',
  'JAR (1 KG)', 'PKT (200 GM)', 'BAG (25 KG)', 'TIN (2.5 KG)', 'CAN (3 LTR)',
  'BTL (750 ML)', 'BTL (1 LTR)', 'PKT (500 GM)', 'BOX (12 pcs)', 'ROLL',
  'BUNDLE', 'SET', 'PAIR', 'SHEET', 'TUBE', 'SACHET', 'CTN (24 pcs)',
  'BAG (5 KG)', 'TIN (400 GM)', 'PKT (1 KG)', 'JAR (500 GM)', 'CAN (1 LTR)',
  'BTL (2 LTR)', 'POUCH (200 ML)', 'TRAY',
];

// Word banks per category, used only by the fallback generator.
const WORDS = {
  PROVISION: ['Basmati Rice', 'Refined Oil', 'Wheat Flour', 'Sugar', 'Salt', 'Toor Dal', 'Chana Dal', 'Mustard Oil', 'Vinegar', 'Soy Sauce', 'Tomato Ketchup', 'Mayonnaise', 'Olive Oil', 'Corn Flour', 'Baking Powder', 'Black Pepper', 'Red Chilli Powder', 'Turmeric', 'Cumin Seed', 'Coriander Powder', 'Garam Masala', 'Bay Leaf', 'Cardamom', 'Cinnamon', 'Clove'],
  'SEMI FINISHED': ['Chicken Seekh Mix', 'Paneer Tikka Marinade', 'Dal Makhani Base', 'Gravy Base', 'Tandoori Marinade', 'Biryani Masala Mix', 'Mint Chutney', 'Tamarind Chutney', 'Pizza Dough', 'Pasta Sauce Base'],
  'VEGETABLES & FRUITS': ['Tomato', 'Onion', 'Potato', 'Ginger', 'Garlic', 'Green Chilli', 'Capsicum', 'Cauliflower', 'Cabbage', 'Carrot', 'Spinach', 'Coriander Leaves', 'Mint Leaves', 'Lemon', 'Banana', 'Apple', 'Pineapple', 'Watermelon', 'Cucumber', 'Mushroom'],
  BUTCHERY: ['Chicken Breast', 'Chicken Leg', 'Mutton Curry Cut', 'Mutton Keema', 'Prawns', 'Fish Basa', 'Fish Surmai', 'Chicken Wings', 'Lamb Chops', 'Chicken Mince'],
  DAIRY: ['Paneer', 'Butter', 'Fresh Cream', 'Cheese Slice', 'Mozzarella', 'Curd', 'Milk', 'Condensed Milk', 'Ghee', 'Yoghurt'],
  CONSUMABLE: ['Tissue Roll', 'Paper Napkin', 'Cling Film', 'Aluminium Foil', 'Butter Paper', 'Straw', 'Toothpick', 'Candle', 'Matchbox', 'Garbage Bag'],
  PRINTABLE: ['Bill Roll', 'KOT Roll', 'Menu Card', 'Table Tent Card', 'Feedback Form', 'Letterhead', 'Visiting Card', 'Sticker Label', 'Envelope', 'Voucher Book'],
  HK: ['Floor Mop', 'Broom', 'Scrubber', 'Duster Cloth', 'Bucket', 'Wiper', 'Hand Brush', 'Dustpan', 'Sponge', 'Glove'],
  CHEMICAL: ['Dishwash Liquid', 'Floor Cleaner', 'Glass Cleaner', 'Toilet Cleaner', 'Bleach', 'Sanitizer', 'Hand Wash', 'Degreaser', 'Descaler', 'Air Freshener'],
  PACKAGING: ['Takeaway Box', 'Paper Bag', 'Carry Bag', 'Food Container', 'Lid', 'Cup', 'Cutlery Pouch', 'Delivery Seal', 'Bubble Wrap', 'Carton Box'],
  'BAR WARE': ['Cocktail Shaker', 'Jigger', 'Bar Spoon', 'Muddler', 'Strainer', 'Ice Bucket', 'Ice Tong', 'Bottle Opener', 'Pourer', 'Peeler'],
  'BAR GLASSWARE': ['Highball Glass', 'Rocks Glass', 'Wine Glass', 'Champagne Flute', 'Martini Glass', 'Beer Mug', 'Shot Glass', 'Hurricane Glass', 'Coupe Glass', 'Snifter'],
  CROCKERY: ['Dinner Plate', 'Quarter Plate', 'Soup Bowl', 'Serving Bowl', 'Tea Cup', 'Saucer', 'Platter', 'Ramekin', 'Sizzler Plate', 'Rice Bowl'],
  CUTLERY: ['Dinner Fork', 'Dinner Knife', 'Table Spoon', 'Tea Spoon', 'Soup Spoon', 'Steak Knife', 'Dessert Fork', 'Serving Spoon', 'Butter Knife', 'Chopstick'],
  'SERVICE WARE': ['Service Tray', 'Chafing Dish', 'Bread Basket', 'Sauce Boat', 'Cruet Set', 'Menu Holder', 'Bill Folder', 'Water Jug', 'Tong', 'Ladle'],
  LIQUOR: ['Old Monk Rum', 'Blenders Pride Whisky', 'Smirnoff Vodka', 'Bacardi White Rum', 'Beefeater Gin', 'Jameson Whiskey', 'Sula Sauvignon Blanc', 'Jack Daniels', 'Chivas Regal', 'Absolut Vodka', 'Johnnie Walker Black', 'Glenlivet 12', 'Bombay Sapphire', 'Captain Morgan', 'Teachers Whisky', 'Antiquity Blue', 'Grey Goose Vodka', 'Hendricks Gin', 'Ballantines', 'Black Dog'],
  BEVERAGES: ['Coca Cola', 'Diet Coke', 'Sprite', 'Fanta', 'Tonic Water', 'Soda', 'Packaged Water', 'Orange Juice', 'Cranberry Juice', 'Pineapple Juice', 'Red Bull', 'Iced Tea', 'Cold Coffee Base', 'Lemonade', 'Ginger Ale'],
};

// Item count per super category — matches the client's real distribution.
const DISTRIBUTION = { FOOD: 299, 'NON FOOD': 128, CCG: 70, LIQUOR: 64, BEVERAGES: 57 };
const BOTTLE_SIZES = [180, 275, 330, 375, 500, 650, 700, 750, 1000];

// Deterministic pseudo-random so a re-seed produces the same master.
function makeRng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function generateFallback() {
  const rng = makeRng(20260804);
  const items = [];
  const used = new Set();

  for (const sc of HIERARCHY) {
    const target = DISTRIBUTION[sc.name];
    const per = Math.floor(target / sc.categories.length);
    let remaining = target;

    sc.categories.forEach((cat, ci) => {
      const isLast = ci === sc.categories.length - 1;
      const count = isLast ? remaining : per;
      remaining -= count;
      const bank = WORDS[cat] || [cat];

      for (let n = 0; n < count; n++) {
        const base = bank[n % bank.length];
        // Vary with a suffix once the bank is exhausted, keeping names unique.
        const variant = n < bank.length ? base : `${base} ${String.fromCharCode(65 + Math.floor(n / bank.length) - 1)}`;
        let name = variant;
        let dedupe = 2;
        while (used.has(name.toLowerCase())) name = `${variant} ${dedupe++}`;
        used.add(name.toLowerCase());

        const isLiquor = sc.name === 'LIQUOR';
        items.push({
          item_name: name,
          super_category: sc.name,
          category: cat,
          unit: isLiquor ? 'BTL (750 ML)' : UNITS[Math.floor(rng() * UNITS.length)],
          is_liquor: isLiquor,
          bottle_size_ml: isLiquor ? BOTTLE_SIZES[Math.floor(rng() * BOTTLE_SIZES.length)] : null,
          rate: Math.round((20 + rng() * 3000) * 100) / 100,
        });
      }
    });
  }
  return items;
}

// Returns { items, source } where source is 'client-csv' or 'generated'.
export function loadItemMaster() {
  if (fs.existsSync(REAL_CSV)) {
    const { records } = parseCsvObjects(fs.readFileSync(REAL_CSV, 'utf8'));
    const items = records
      .map((r) => ({
        // Only leading/trailing whitespace is stripped. Nothing else about the
        // client's values is altered — unit especially is used verbatim.
        item_name: (r.item_name || r.name || '').trim().replace(/\s+/g, ' '),
        super_category: (r.super_category || '').trim(),
        category: (r.category || '').trim(),
        unit: (r.unit || '').trim(),
        is_liquor: truthy(r.is_liquor),
        bottle_size_ml: r.bottle_size_ml ? parseInt(r.bottle_size_ml, 10) || null : null,
        rate: r.rate ? parseFloat(r.rate) || null : null,
      }))
      .filter((r) => r.item_name);
    return { items, source: 'client-csv' };
  }
  return { items: generateFallback(), source: 'generated' };
}
