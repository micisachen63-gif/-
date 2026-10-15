// Automated batch generator for pet exclusive artwork using Grok web via CDP 19386
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createGrokSceneImage } from '../../haigui-scene.js';

const PUBLIC_DIR = 'C:/Users/User/Documents/ChatGPT/爆分監控/cloudflare/public/assets';
const HANDOFF_DIR = 'C:/Users/User/Documents/ChatGPT/營運自動化/assets/pet-handoff';

fs.mkdirSync(path.join(PUBLIC_DIR, 'stages'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_DIR, 'variants'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_DIR, 'gear'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_DIR, 'scrolls'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_DIR, 'bosses'), { recursive: true });
fs.mkdirSync(path.join(HANDOFF_DIR, 'stages'), { recursive: true });
fs.mkdirSync(path.join(HANDOFF_DIR, 'variants'), { recursive: true });
fs.mkdirSync(path.join(HANDOFF_DIR, 'gear'), { recursive: true });
fs.mkdirSync(path.join(HANDOFF_DIR, 'scrolls'), { recursive: true });
fs.mkdirSync(path.join(HANDOFF_DIR, 'bosses'), { recursive: true });

export const TASKS = [
  // --- 1. Growth Stages (9 images; complete stage uses base images) ---
  {
    type: 'stages',
    name: 'yingma_young.png',
    prompt: 'Please generate an image: A cute newborn baby Greek sparrow chick mascot. Adorable tiny round fluffy bird with big curious eyes, soft baby feathers, tiny golden olive leaf pin, cute baby hero toga diaper. Mythical Greek video game mascot style, clean vibrant colors, full body character portrait on a solid clean warm gradient background.'
  },
  {
    type: 'stages',
    name: 'yingma_growing.png',
    prompt: 'Please generate an image: A cute adolescent Greek sparrow warrior pet. Lively energetic young bird with emerging golden wings, wearing an apprentice leather and bronze hero tunic with a tiny wooden sword. Determined cute expression. Greek fantasy game mascot art style, full body character portrait on a clean gradient background.'
  },
  {
    type: 'stages',
    name: 'yingma_mature.png',
    prompt: 'Please generate an image: A majestic mature Greek mythology sparrow hero pet. Proud noble bird warrior with gleaming golden feathered wings, wearing polished bronze and gold Greek hoplite chestplate armor and red hero cape. Confident gaze. Mythical game mascot style, high quality full body portrait on a clean gradient background.'
  },
  {
    type: 'stages',
    name: 'shuangbao_young.png',
    prompt: 'Please generate an image: An adorable newborn 2D pixel-art cyber digital baby pet. Extremely cute round pixel blob creature with glowing cyan pixel smile face and a tiny blinking computer chip LED antenna. 16-bit retro arcade video game mascot pixel art style, crisp pixels, clean cyber background.'
  },
  {
    type: 'stages',
    name: 'shuangbao_growing.png',
    prompt: 'Please generate an image: A cute growing adolescent 2D pixel-art cyber digital creature. Energetic bipedal young robotic monster with neon cyan circuit trails, holding a tiny digital laser pointer gadget, pixel visor eyes. 16-bit arcade video game mascot pixel art style, clean dark cyber grid background.'
  },
  {
    type: 'stages',
    name: 'shuangbao_mature.png',
    prompt: 'Please generate an image: A powerful mature 2D pixel-art cybernetic digital beast. Sleek agile robotic creature equipped with advanced cyan cyber armor plates, holographic head-up display visor, and glowing energy booster wings. 16-bit retro arcade game mascot pixel art, clean dark cyber background.'
  },
  {
    type: 'stages',
    name: 'qiezi_young.png',
    prompt: 'Please generate an image: An adorable tiny baby eggplant pet mascot. Super cute round plump purple baby eggplant fruit with huge sparkling kawaii eyes, two tiny green sprout leaves like bunny ears, blushing cheeks. Ultra cute video game mascot art style, clean bright gradient background.'
  },
  {
    type: 'stages',
    name: 'qiezi_growing.png',
    prompt: 'Please generate an image: A cute cheerful young purple eggplant creature mascot. Bouncy joyful eggplant character wearing a cute red bowtie, cheerfully holding a tiny single lucky six-sided dice. Big happy smile, green leaves. Whimsical cartoon video game mascot style, clean gradient background.'
  },
  {
    type: 'stages',
    name: 'qiezi_mature.png',
    prompt: 'Please generate an image: A dashing charming mature purple eggplant gentleman mascot. Plump royal purple eggplant wearing a small silver aristocrat crown, a mini red velvet cape, holding a lucky golden coin, floating playing card suits. Cute whimsical game character art on a clean background.'
  },

  // --- 2. Complete Variants: 贏麻了 (10 images) ---
  {
    type: 'variants',
    name: 'yingma_thunder.png',
    prompt: 'Please generate an image: A legendary thunder emperor sparrow god. A divine Greek eagle-sparrow pet clad in golden thunderbolt plate armor, wings crackling with violent golden and electric-blue lightning bolts, wielding a miniature glowing spear of Zeus. Epic game mascot character art, glowing thunder aura, clean dark gradient background.'
  },
  {
    type: 'variants',
    name: 'yingma_solar.png',
    prompt: 'Please generate an image: A legendary solar sun god bird hero. Adorable yet magnificent golden sparrow pet ablaze with brilliant Apollo sunfire, wearing an exquisite radiant sun-crown, golden feathered wings radiating blazing sunlight and solar flares. Mythical Greek game mascot portrait on a clean warm background.'
  },
  {
    type: 'variants',
    name: 'yingma_wind.png',
    prompt: 'Please generate an image: A legendary storm wind zephyr sparrow bird hero. Sleek hyper-agile avian fighter with emerald-green aero wings, surrounded by swirling gale tornadoes and razor-sharp wind blades. Fast ninja-like motion trails. Fantasy game mascot character portrait on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_void.png',
    prompt: 'Please generate an image: A legendary underworld dark phoenix sparrow bird hero. Majestic dark obsidian feathers glowing with eerie royal-purple spirit flame, glowing mystical purple eyes, wearing dark nether armor accents. Mythical Hades game character art, purple infernal aura on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_seraph.png',
    prompt: 'Please generate an image: A celestial seraph angel sparrow bird hero. Six luminous angelic feathered wings glowing with pure pearlescent starlight, three glowing golden halos above its head, showering glittering cosmic stardust. Divine fantasy game mascot portrait on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_terra.png',
    prompt: 'Please generate an image: A titan of earth stone sparrow hero. Sturdy mythical bird armored in ancient mossy stone and amber crystal plates, rocky gauntlets, glowing earthy runes on its chest. Powerful Gaia rock mascot design, full body portrait on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_ocean.png',
    prompt: 'Please generate an image: An oceanic sea emperor Poseidon sparrow bird hero. Shimmering sapphire and aqua water-feathered wings, riding swirling tidal waves and ocean spray, holding a tiny glowing sea trident. Mythical water game mascot art on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_ares.png',
    prompt: 'Please generate an image: An Ares war god berserker sparrow bird hero. Fierce avian gladiator covered in spiked crimson bronze battle armor, glowing blood-red eyes and wings ablaze with fiery crimson war aura, battle-hardened hero. Dynamic epic game mascot on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_aegis.png',
    prompt: 'Please generate an image: An Athena divine shield paladin sparrow bird hero. Valiant winged guardian holding the glowing golden Aegis shield with medusa emblem, wearing a classic Greek Athena crested helmet with white plume. Noble heroic game mascot on a clean background.'
  },
  {
    type: 'variants',
    name: 'yingma_fate.png',
    prompt: 'Please generate an image: A celestial fate weaver oracle sparrow bird hero. Mystical cosmic bird pet adorned with glowing pink-gold threads of destiny, a floating golden astrolabe horoscope wheel behind its back, glowing starry aura. Enigmatic fantasy game mascot on a clean background.'
  },

  // --- 3. Complete Variants: 爽爆 (10 images) ---
  {
    type: 'variants',
    name: 'shuangbao_cyber.png',
    prompt: 'Please generate an image: A quantum overclocked cyber digital beast. 16-bit retro arcade pixel art mascot, glowing vibrant emerald-green binary code streams coursing across its futuristic cyber armor, hyper-speed hologram afterimages. Epic retro gaming mascot on dark grid background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_armor.png',
    prompt: 'Please generate an image: A heavy armored dreadnought titan pixel digital beast. Massive tungsten-steel pixel armor plating, heavy blast shield on its arm, pulsating cobalt energy core in its chest, tank-like robotic treads. 16-bit arcade pixel art style, clean dark cyber background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_plasma.png',
    prompt: 'Please generate an image: A high-voltage plasma ionic cyber digital pet. Robotic creature sparking with millions of volts of cyan plasma lightning arcs, dual shoulder-mounted plasma cannons charging electric energy. 16-bit retro arcade pixel art on dark background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_virus.png',
    prompt: 'Please generate an image: A darknet zero corrupted virus pixel monster. Menacing yet cool cyber beast covered in glowing crimson malicious code, pixel glitch artifacts, glowing evil red eye visor. 16-bit retro arcade pixel art style on dark matrix background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_matrix.png',
    prompt: 'Please generate an image: A matrix code pioneer cyber digital monster. Futuristic hacker beast with floating holographic digital terminal screens and green falling digital rain wings. 16-bit arcade pixel art mascot design on dark digital space background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_photon.png',
    prompt: 'Please generate an image: A faster-than-light photon booster cyber digital pet. Aerodynamic futuristic speed machine beast with blazing gold and yellow plasma jet thrusters, sleek racing armor plates. 16-bit arcade retro pixel art on dark background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_neural.png',
    prompt: 'Please generate an image: An artificial neural network supermind cyber pet. Futuristic robotic creature with a translucent dome skull revealing an intricate glowing purple AI neural network brain. 16-bit retro pixel arcade game mascot on dark background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_emp.png',
    prompt: 'Please generate an image: An EMP electromagnetic pulse shockwave digital pet. Cyber beast carrying high-frequency magnetic coil rings floating on its back, discharging bright electric-blue EMP rings. 16-bit arcade pixel art mascot on dark cyber background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_mirage.png',
    prompt: 'Please generate an image: A holographic mirage cloaking cyber digital beast. Cybernetic pet split into multiple chromatic aberration optical illusions and rainbow prism holographic clones. 16-bit retro arcade pixel art on dark grid background.'
  },
  {
    type: 'variants',
    name: 'shuangbao_gravity.png',
    prompt: 'Please generate an image: A quantum gravity singularity dark matter pixel beast. Cosmic cyber monster housing a miniature swirling deep-purple black hole event horizon at its core, warping spacetime around it. 16-bit pixel art style on dark background.'
  },

  // --- 4. Complete Variants: 茄子 (10 images) ---
  {
    type: 'variants',
    name: 'qiezi_casino.png',
    prompt: 'Please generate an image: The supreme golden dice king eggplant pet mascot. Lavish purple eggplant wearing an opulent diamond-encrusted gold crown, surrounded by tumbling sparkling solid gold dice and casino chips, lucky golden jackpot aura. Fun cartoon game character art on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_royal.png',
    prompt: 'Please generate an image: An aurora emperor supreme royal eggplant character mascot. Dignified purple eggplant dressed in an imperial royal ermine-lined velvet robe, wearing a glittering aurora gem crown and holding a sparkling royal scepter. Whimsical cartoon video game mascot on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_mystic.png',
    prompt: 'Please generate an image: An astrology zodiac wizard purple eggplant pet mascot. Wearing a mystical star-patterned pointed wizard hat, floating above a glowing zodiac circle while conjuring a swirling galaxy crystal ball. Whimsical fantasy game mascot art on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_joker.png',
    prompt: 'Please generate an image: A mischievous chaos joker jester eggplant pet mascot. Wacky playful eggplant in a two-toned purple and black jester hat with jingling golden bells, juggling magical exploding party dice and cards. Vibrant cartoon game mascot art on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_wealth.png',
    prompt: 'Please generate an image: A god of wealth fortune cornucopia eggplant pet mascot. Plump cheerful purple eggplant carrying a treasure bowl overflowing with traditional golden ingots, coins, and red envelopes, radiant lucky yellow gold aura. Festive cartoon game character on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_koi.png',
    prompt: 'Please generate an image: A super lucky golden koi fish blessed eggplant mascot. Round purple eggplant character adorned with traditional red and gold koi fish scales and flowing koi tail cape, lucky lotus flower and water ripples. Cute celebratory game mascot art on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_chronos.png',
    prompt: 'Please generate an image: A chronos timekeeper hourglass eggplant mascot. Mysterious purple eggplant floating amidst floating glowing brass clockwork gears and a magical floating hourglass with glowing golden sand. Whimsical time magic game mascot on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_cards.png',
    prompt: 'Please generate an image: A royal flush cardmaster eggplant mascot. Cool dashing eggplant wearing a sleek black tuxedo vest and sunglasses, dynamically fanning out a glowing magical royal flush of spade cards. Stylish cartoon game mascot on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_magic.png',
    prompt: 'Please generate an image: An illusionist master magician eggplant mascot. Charismatic purple eggplant wearing a tall black silk top hat and red cape, waving a magic wand that erupts into white doves and playing card ribbons. Charming cartoon game mascot on clean background.'
  },
  {
    type: 'variants',
    name: 'qiezi_abundance.png',
    prompt: 'Please generate an image: A harvest nature spirit eggplant god mascot. Vibrant purple eggplant crowned with lush green grapevine leaves, wheat stalks, and blooming wildflowers, surrounded by bountiful golden fruits and fairy motes. Joyful pastoral game mascot art on clean background.'
  },

  // --- 5. Equipment Gear (5 images: Weapon, Helmet, Armor, Gloves, Boots) ---
  {
    type: 'gear',
    name: 'weapon.png',
    prompt: 'Please generate an image: A legendary Japanese samurai katana sword video game equipment icon. Sleek curved razor steel blade with glowing mystic runes, golden dragon tsuba guard, wrapped dark tsuka hilt, floating on a clean dark gradient background, fantasy RPG item icon art style.'
  },
  {
    type: 'gear',
    name: 'helmet.png',
    prompt: 'Please generate an image: A sturdy steel warrior knight helmet video game armor equipment icon. Polished hardened steel full-face helm with golden crest accents and dark visor slit, glowing subtly, fantasy RPG item icon on clean gradient background.'
  },
  {
    type: 'gear',
    name: 'armor.png',
    prompt: 'Please generate an image: A legendary dragon scale heavy plate armor chestplate video game armor icon. Impressive iridescent dragon scales overlapping on a gilded mithril cuirass, glowing with elemental draconic aura, fantasy RPG item icon on clean gradient background.'
  },
  {
    type: 'gear',
    name: 'gloves.png',
    prompt: 'Please generate an image: A pair of divine power gauntlets video game armor equipment icon. Heavy reinforced armored battle gloves with glowing power runestones on knuckles, metallic bronze and gold finish, fantasy RPG item icon on clean background.'
  },
  {
    type: 'gear',
    name: 'boots.png',
    prompt: 'Please generate an image: A pair of swift wind combat boots video game armor equipment icon. Sleek enchanted leather and winged steel greaves boots with glowing emerald wind particles, fantasy RPG item icon on clean gradient background.'
  },

  // --- 6. Enhancement & Reroll Scrolls (3 images) ---
  {
    type: 'scrolls',
    name: 'weapon_scroll.png',
    prompt: 'Please generate an image: An ancient weapon enhancement magic scroll video game item icon. Unfurled glowing golden parchment scroll depicting an engraved fiery sword emblem with arcane runic glyphs floating around it, magical sparkle aura on clean dark background.'
  },
  {
    type: 'scrolls',
    name: 'armor_scroll.png',
    prompt: 'Please generate an image: An ancient armor enhancement magic scroll video game item icon. Unfurled glowing azure parchment scroll depicting an engraved glowing shield emblem with radiant protective runes, mystic blue light on clean dark background.'
  },
  {
    type: 'scrolls',
    name: 'reroll_scroll.png',
    prompt: 'Please generate an image: A mysterious arcane transmutation reroll magic scroll video game item icon. An ornate prismatic purple scroll glowing with swirling six-color elemental aura (earth, water, fire, wind, light, dark), dice runes and sparkling stars, clean dark background.'
  },

  // --- 7. Six Elemental Bosses (6 images) ---
  {
    type: 'bosses',
    name: 'boss_earth.png',
    prompt: 'Please generate an image: A colossal ancient earth titan stone colossus boss monster. Massive monolith beast constructed from deep mossy granite, glowing amber crystal veins, towering boulders for shoulders, glowing volcanic yellow eyes. Epic fantasy RPG boss portrait on clean dark background.'
  },
  {
    type: 'bosses',
    name: 'boss_water.png',
    prompt: 'Please generate an image: A terrifying nine-abyss oceanic leviathan sea emperor boss monster. Gigantic abyssal sea beast with glowing bioluminescent aqua scales, massive tidal horns, surrounded by roaring oceanic whirlpools and crushing ocean waves, glowing blue eyes. Epic fantasy RPG boss portrait on clean background.'
  },
  {
    type: 'bosses',
    name: 'boss_fire.png',
    prompt: 'Please generate an image: A ferocious infernal magma drake dragon boss monster. Enormous colossal fire lizard rising from volcanic lava, armored in jagged burning obsidian plates, smoke billows and blazing crimson flames bursting from mouth and back. Epic fantasy RPG boss portrait on clean background.'
  },
  {
    type: 'bosses',
    name: 'boss_wind.png',
    prompt: 'Please generate an image: A legendary tempest storm roc bird boss monster. Colossal celestial wind bird with wings of raging emerald tornadoes and lightning storms, razor-sharp gale talons, piercing hawk gaze. Epic fantasy RPG boss portrait on clean background.'
  },
  {
    type: 'bosses',
    name: 'boss_light.png',
    prompt: 'Please generate an image: A majestic celestial dawn radiant colossus boss monster. Ancient sacred stone and gold winged titan bathed in blinding holy golden sunlight, glowing halos and divine solar rays, serene yet awe-inspiring divine gaze. Epic fantasy RPG boss portrait on clean background.'
  },
  {
    type: 'bosses',
    name: 'boss_dark.png',
    prompt: 'Please generate an image: A terrifying void nether lord demon boss monster. Colossal shadowy abyssal horror entity shrouded in swirling black and royal-purple dark matter nebula, crimson void eyes, menacing horns. Epic fantasy RPG boss portrait on clean background.'
  }
];

export async function runBatch({ startIdx = 0, count = TASKS.length } = {}) {
  console.log(`=== Starting Pet Exclusive Artwork Batch Generation ===`);
  console.log(`Total tasks: ${TASKS.length}, Processing from index ${startIdx} to ${Math.min(TASKS.length, startIdx + count)}`);

  const grok = createGrokSceneImage({ endpoint: 'http://127.0.0.1:19386' });
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < slice.length; i++) {
    const task = slice[i];
    const globalIdx = startIdx + i + 1;
    const pubFile = path.join(PUBLIC_DIR, task.type, task.name);
    const handoffFile = path.join(HANDOFF_DIR, task.type, task.name);

    // Skip if already generated and valid
    if (fs.existsSync(pubFile)) {
      const stats = fs.statSync(pubFile);
      if (stats.size > 10000) {
        console.log(`[${globalIdx}/${TASKS.length}] ⏩ Skipping ${task.name} (already exists: ${stats.size} bytes)`);
        skippedCount++;
        continue;
      }
    }

    console.log(`\n--------------------------------------------------`);
    console.log(`[${globalIdx}/${TASKS.length}] 🎨 Generating: ${task.type}/${task.name}`);
    console.log(`Prompt: ${task.prompt}`);
    const t0 = Date.now();

    try {
      const result = await grok(task.prompt, { deadline: Date.now() + 120e3 });
      if (result?.buffer && result.buffer.length > 5000) {
        fs.writeFileSync(pubFile, result.buffer);
        fs.writeFileSync(handoffFile, result.buffer);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        successCount++;

        // Auto-deploy every 3 images
        if (successCount % 3 === 0) {
          try {
            console.log(`🚀 [Auto-Deploy] Deploying latest assets to Cloudflare...`);
            execSync('npx.cmd wrangler deploy', {
              cwd: 'C:/Users/User/Documents/ChatGPT/爆分監控/cloudflare',
              stdio: 'ignore'
            });
            console.log(`✅ [Auto-Deploy] Cloudflare assets updated!`);
          } catch (e) {
            console.warn(`⚠️ [Auto-Deploy] Notice: ${e.message}`);
          }
        }
      } else {
        console.warn(`❌ [${globalIdx}/${TASKS.length}] Failed to get valid image for ${task.name}`);
        failedCount++;
      }
    } catch (err) {
      console.error(`❌ [${globalIdx}/${TASKS.length}] Error generating ${task.name}: ${err.message}`);
      failedCount++;
    }

    // Brief safety pause between browser tasks
    await new Promise(r => setTimeout(r, 2000));
  }

  // Final deploy
  if (successCount > 0) {
    try {
      console.log(`🚀 [Final Deploy] Deploying all new assets to Cloudflare...`);
      execSync('npx.cmd wrangler deploy', {
        cwd: 'C:/Users/User/Documents/ChatGPT/爆分監控/cloudflare',
        stdio: 'ignore'
      });
      console.log(`✅ [Final Deploy] Cloudflare assets updated!`);
    } catch (e) {
      console.warn(`⚠️ [Final Deploy] Notice: ${e.message}`);
    }
  }

  console.log(`\n==================================================`);
  console.log(`Batch Summary: Success: ${successCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
  console.log(`==================================================\n`);
}

// Direct execution
runBatch().catch(err => {
  console.error('Fatal batch error:', err);
  process.exit(1);
});
  const slice = TASKS.slice(startIdx, startIdx + count);
