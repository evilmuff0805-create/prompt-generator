const GALLERY_CATEGORIES = [
  { id: "all",          label: "All" },
  { id: "architecture", label: "Architecture" },
  { id: "portrait",     label: "Portrait" },
  { id: "fashion",      label: "Fashion" },
  { id: "branded",      label: "Branded Products" },
  { id: "design",       label: "Design" },
  { id: "food",         label: "Food" }
];

const galleryData = [
  {
    id: 1,
    title: "Organic Futurism",
    category: "architecture",
    image: "/gallery/1.png",
    prompt: `This image presents a stunning, photorealistic 3D render of a futuristic architectural complex, seamlessly blending organic design with vibrant natural elements. The scene exudes a serene and innovative mood, showcasing a multi-story building characterized by undulating wooden structures and expansive curved glass facades that reflect the clear blue sky. Surrounding the structure are meticulously designed terraced gardens, bursting with a tapestry of multi-colored flowers, and winding, interconnected water features, all integrated by elegant stone pathways. The overall visual impact is one of harmonious integration between cutting-edge architecture and a lush, biophilic landscape under bright, natural daylight.

SUBJECT: A futuristic, biomorphic architectural complex featuring a multi-story building with undulating wooden structures and large curved glass facades, seamlessly integrated with terraced gardens and winding water features. The building's design incorporates a lattice-like wooden framework over some glass sections.

SCENE: Outdoor architectural garden complex on a gentle hill at Daytime, late morning to early afternoon, Clear sky with minimal, wispy clouds. Key element: The organic, wave-like wooden lattice structure covering parts of the building and extending into the terraced landscape, creating a fluid connection between architecture and nature.

BACKGROUND: Clear blue sky, Scattered wispy white clouds, Distant horizon line with subtle green foliage (implied)

LIGHTING: Natural sunlight, From the upper right, casting soft, defined shadows, Bright, clear, and evenly diffused across the scene

TECHNICAL: Virtual Camera (3D Render), Wide-angle to standard lens (e.g., 24-50mm equivalent), f/8 - f/11 (for deep depth of field), ISO 100 (simulated for clean render)

COMPOSITION: Wide shot, showcasing the entire complex from an elevated, slightly oblique perspective, Slightly high angle, looking down onto the complex, focus on The central building and the immediate surrounding gardens and water features

STYLE: 3d_render, Biophilic architecture, Organic design, Futuristic, Sustainable design, Luxury resort aesthetic, Architectural visualization, Photorealistic render, Dominant warm wood tones #A07D5D, vibrant floral hues including purple #8A2BE2, bright yellow #FFD700, and vivid orange #FFA500. Clear sky blue #87CEEB and reflective water blue #ADD8E6. Stone paving in light beige #D2B48C.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Undulating wooden architectural structure with lattice details, Large curved glass facades reflecting the sky, Terraced gardens with vibrant multi-colored flowers (purple, yellow, orange), Winding, interconnected water features/ponds, Stone-paved pathways with irregular flagstone pattern, Clear blue sky with minimal clouds, Overall biophilic and organic design aesthetic
CONSTRAINTS - Avoid: Any human figures or vehicles, Overcast, stormy, or dramatic weather conditions, Industrial or harsh urban elements, Night scene or artificial lighting as primary illumination`
  },
 {
    id: 2,
    title: "Mint Dream",
    category: "portrait",
    image: "/gallery/2.png",
    prompt: `This is a striking, high-resolution studio photograph with a surreal and artistic aesthetic, capturing a young woman with a serene expression. Her vibrant mint green hair and captivating heterochromatic eyes are dramatically framed by a dynamic, swirling splash of glossy, two-toned liquid paint. The clean, minimalist white background emphasizes the subject and the fluid motion, creating a modern, high-fashion visual impact that is both ethereal and hyperrealistic.

SUBJECT: A young woman with fair, smooth skin and delicate, symmetrical facial features. with Mint green #80E8C7, with slightly darker teal #40B8A0 roots and undertones. hair styled in Wavy, medium length, with a soft fringe/bangs falling across the forehead, appearing slightly tousled yet styled.. Expression: Neutral, calm, with a direct and steady gaze towards the viewer.. Pose: Head-on, facing the camera, with bare shoulders subtly visible.

SCENE: Professional studio setting at Not applicable (studio lighting), Not applicable (indoor studio). Key element: A dynamic, swirling splash of viscous liquid paint forming a circular frame around the subject's head. The liquid is two-toned, featuring a lighter mint green #90EE90 and a darker teal #008080, with visible drips and droplets, appearing frozen in motion.

LIGHTING: Softbox studio lighting, Frontal and slightly overhead, Even, diffused, high-key, creating soft shadows and highlighting details.

TECHNICAL: High-end mirrorless camera (e.g., Sony Alpha a7R IV), 85mm f/1.4 prime lens, f/2.8, ISO 100

COMPOSITION: Medium close-up, head and shoulders, Eye-level, focus on Subject's eyes and face

STYLE: photography, digital art, Surreal, Vibrant, High-fashion, Conceptual art, Clean minimalist, Hyperrealistic, Dominant mint green #80E8C7 and teal #008080, accented by pure white #FFFFFF background, purple #800080 and blue #0000FF eyes, and soft pink #FFC0CB lips.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Young woman with mint green hair, Heterochromia: one purple eye #800080 and one blue eye #0000FF, Dynamic, swirling liquid paint splash framing the face, Two distinct shades of green/teal in the liquid splash (light mint green #90EE90 and teal #008080), Clean, pure white #FFFFFF background, Subject's direct, neutral gaze
CONSTRAINTS - Avoid: Distracting background elements or textures, Aggressive or overly dramatic facial expressions, Visible clothing or accessories on the subject, Any text, logos, or branding`
  },
 {
    id: 3,
    title: "Ice Breaker",
    category: "fashion",
    image: "/gallery/3.png",
    prompt: `This striking contemporary photograph captures a surreal urban scene, featuring a young East Asian woman with vibrant pink hair suspended within a massive, clear ice block on a sunlit city sidewalk. The mood is one of ethereal stillness and quiet contemplation, juxtaposing the frozen subject with the warmth of a bright day. The crisp, high-contrast lighting and vivid color palette, dominated by cool whites and blues punctuated by the subject's bold pink and yellow attire, create a captivating visual impact that blends fashion photography with a dreamlike, almost melancholic narrative.

SUBJECT: A young East Asian woman with pale skin and delicate features, appearing slender and graceful. She is suspended horizontally within a large, clear ice block. with Bright pink #E84887 hair styled in Short, bob-length hair pulled back into a small, slightly messy bun at the nape of her neck, with some strands framing her face.. Expression: Serene and neutral, with slightly parted lips and a direct gaze.. Pose: Floating horizontally within the ice block, knees bent and slightly tucked, arms outstretched to the sides with hands gently pressing against the inner surface of the ice. Her body is angled slightly towards the right.

CLOTHING & STYLING: Bright yellow #FDE74C Ribbed cotton Tank top, Light blue #77AADD Denim Denim shorts, Bright pink #E84887 Opaque, matte synthetic Tights/Leggings, Black #000000 Glossy synthetic leather Boots

ACCESSORIES: Earrings Red #FF0000 Glossy, possibly plastic or enamel

SCENE: An urban sidewalk next to an asphalt street, with a grand, neoclassical-style white building in the background. at Daytime, likely late morning or early afternoon., Clear, sunny, bright.. Key element: A massive, rectangular block of clear ice, approximately 2 meters wide and 1.5 meters tall, with internal cracks, bubbles, and a slightly textured surface, containing the suspended woman.

BACKGROUND: Large, multi-story white #F5F5F5 building with numerous symmetrical rectangular windows (dark frames, light panes)., Black #000000 street lamp pole to the left of the building., Green #008000 trees visible in the distance on both sides of the street., Gray #808080 asphalt road with a faint yellow #FFFF00 line., Light gray #D3D3D3 concrete sidewalk with visible expansion joints., Puddles of melted ice water reflecting the surroundings on the sidewalk., Small, irregularly shaped chunks of ice scattered around the base of the large ice block.

LIGHTING: Natural sunlight, Overhead, slightly from the right, casting distinct shadows., Bright, clear, high contrast with sharp highlights and shadows.

TECHNICAL: Sony Alpha a7 III, 50mm f/1.8 prime lens, f/5.6, ISO 100

COMPOSITION: Medium full shot, capturing the entire ice block and subject, with significant background context., Eye-level., focus on The woman inside the ice block.

STYLE: photography, Surrealism, Contemporary art, Fashion photography, Urban fantasy, High contrast, Dominant cool tones (white #F5F5F5, light blue #77AADD, clear ice) contrasted with vibrant warm accents (bright pink #E84887, bright yellow #FDE74C, red #FF0000).

ASPECT RATIO: 4:5

CONSTRAINTS - Must keep: Young East Asian woman with bright pink hair., Woman suspended horizontally inside a large, clear ice block., Ice block melting on a concrete sidewalk with puddles and ice chunks., Elegant white neoclassical building with multiple windows in the background., Bright, sunny outdoor urban setting with a street and trees., Subject wearing a yellow tank top, denim shorts, pink tights, and black boots.
CONSTRAINTS - Avoid: Any signs of distress, struggle, or discomfort from the subject., Overly dramatic, dark, or moody lighting., Excessive fantasy elements beyond the core concept of the ice block and suspended person., Any text or branding on the clothing other than the small flower graphic.`
  },
  {
    id: 4,
    title: "Cherry Essence",
    category: "branded",
    image: "/gallery/4.png",
    prompt: `This is a hyperrealistic 3D render or high-end product photograph, capturing a dynamic and refreshing scene centered around a bottle of "Cherry Essence" juice. The glass bottle, covered in glistening condensation, is suspended mid-air, surrounded by a vibrant splash of deep red cherry juice, ripe whole cherries with green leaves, and crystalline ice cubes. The overall mood is one of freshness and vitality, emphasized by the rich, contrasting color palette and the frozen-in-motion elements against a dramatic gradient red background.

SUBJECT: A clear glass bottle, slightly tapered towards the neck, filled with a dark cherry-red liquid. The bottle is covered in numerous small condensation droplets, giving it a chilled appearance. It has a black #000000 screw cap.. Pose: Tilted diagonally upwards from left to right, appearing to be in motion.

ACCESSORIES: Product label dark maroon #4A0010 textured paper

SCENE: Abstract studio setting at N/A, N/A. Key element: The central glass bottle of 'Cherry Essence' juice, covered in condensation, is the focal point, surrounded by elements suggesting freshness and flavor.

BACKGROUND: Dynamic splash of dark cherry juice #8B0000, forming intricate patterns and droplets around the bottle., Six individual ripe cherries, deep red #8B0000, some with green stems and leaves #008000, appearing to float., Five clear, irregularly shaped ice cubes, with subtle blue #ADD8E6 reflections, also floating., Numerous small, spherical juice droplets scattered throughout the scene.

LIGHTING: Studio lighting, Multi-directional, with key light from top-left and fill from bottom-right, creating specular highlights on wet surfaces and ice., Soft, diffused, with high contrast on reflections and droplets.

TECHNICAL: 3D Render Engine (e.g., Blender Cycles, OctaneRender), 50mm prime lens equivalent, f/9, ISO 100

COMPOSITION: Medium shot, bottle positioned diagonally across the frame, slightly off-center., Slightly low angle, looking up at the bottle and surrounding elements., focus on The 'Cherry Essence' bottle and its label.

STYLE: 3d_render, hyperrealistic, product_photography, dynamic_motion, vibrant, refreshing, clean_studio_shot, high_resolution, Dominant deep reds (background gradient from dark maroon #800020 to bright cherry red #C70039, juice #8B0000), contrasting gold #D4AF37 for text, clear/white for ice #FFFFFF, and vibrant green #008000 for leaves.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Clear glass bottle with condensation, Dark maroon label with 'Cherry Essence' in gold script, Dynamic splash of dark red cherry juice, Multiple whole ripe cherries with green stems and leaves, Floating clear ice cubes, Gradient red background (darker to lighter)
CONSTRAINTS - Avoid: Any other types of fruit or ingredients, A static or flat composition, A cluttered or naturalistic background, Any visible human elements or hands, Text other than 'Cherry Essence' and 'Juice'`
  },
 {
    id: 5,
    title: "Floral Letter P",
    category: "design",
    image: "/gallery/5.png",
    prompt: `This is a stunning 3D render, showcasing a whimsical and ethereal artistic style. The central focus is a volumetric letter "P," crafted from a translucent, iridescent material that shimmers with a rainbow of pastel hues, resembling a delicate soap bubble or blown glass. Inside this magical enclosure, a miniature garden flourishes, filled with vibrant flowers, lush greenery, and a solitary monarch butterfly, all set against a stark, pure black background that accentuates its glowing, dreamlike quality. The overall mood is enchanting and delicate, blending natural beauty with fantastical design.

SUBJECT: A three-dimensional, volumetric letter 'P' with smooth, organic, slightly irregular contours. It is made of a translucent, iridescent material that reflects a spectrum of colors including pink #FFC0CB, blue #ADD8E6, green #90EE90, yellow #FFFFE0, orange #FFA07A, and purple #DDA0DD. The surface appears wet or glassy, with subtle refractions and highlights. The interior of the letter is hollow and filled with a miniature, vibrant garden.

SCENE: Abstract void at Timeless, Not applicable. Key element: The interior of the letter 'P' contains a miniature ecosystem with various flora and fauna. This includes multiple pink roses #E84887, orange marigolds #FFA500, white daisies #FFFFFF with yellow centers #FFD700, sprigs of lavender #B57EDC, green fern leaves #228B22, delicate white baby's breath flowers #FFFFFF, clusters of red berries #FF0000, and patches of vibrant green moss #6B8E23. A single monarch butterfly #FFA500 with black #000000 veins and white spots is perched inside.

LIGHTING: Studio lighting, Multi-directional, emphasizing iridescence and reflections, Soft, diffused, with subtle rim lighting effects

TECHNICAL: 3D Render Engine, Simulated Macro Lens, f/2.8, ISO 100

COMPOSITION: Centered, medium shot, showcasing the entire letter 'P', Eye-level, slightly elevated to reveal the top surface and internal details, focus on The entire letter 'P' and its internal elements are in sharp focus

STYLE: 3d_render, iridescent, translucent, bioluminescent, ethereal, whimsical, botanical art, macro photography style, dreamlike, Dominant iridescent spectrum (pink #FFC0CB, blue #ADD8E6, green #90EE90, yellow #FFFFE0, orange #FFA07A, purple #DDA0DD) against pure black #000000, complemented by vibrant natural greens #228B22, pinks #E84887, oranges #FFA500, whites #FFFFFF, and reds #FF0000 from the flora and fauna.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Letter 'P' shape, Iridescent, bubble-like, translucent material for the letter, Pure black background, Variety of flowers (roses, marigolds, daisies, lavender, baby's breath) inside, Green moss and fern inside, Red berries inside, Monarch butterfly inside
CONSTRAINTS - Avoid: Any background elements or textures other than pure black, Other letters, numbers, or symbols, Opaque materials for the letter 'P', Human figures or animals other than the specified butterfly, Distorted or abstract letter shape`
  },
  {
    id: 6,
    title: "Golden Hour Editorial",
    category: "fashion",
    image: "/gallery/6.png",
    prompt: `This is a captivating editorial photograph, imbued with a vintage and slightly melancholic aesthetic. A young East Asian woman reclines elegantly on a deep teal velvet sofa within a meticulously styled, retro living room. The scene exudes a quiet, contemplative mood, characterized by soft, diffused lighting and a rich, muted color palette that highlights the textures of the fabrics and the classic decor. The composition is balanced and serene, drawing the viewer into a moment of stillness and understated elegance.

SUBJECT: A young East Asian woman with fair skin and a slender build. with black #000000 hair styled in straight bob cut, pulled back, middle-parted. Expression: neutral, direct gaze, slightly parted lips. Pose: Reclining on a sofa, left arm resting on the backrest, right hand gently touching her chin/ear, legs crossed at the ankles, bare feet.

CLOTHING & STYLING: olive green #808000 satin long-sleeved collared shirt, mustard yellow #FFDB58 velvet midi skirt

ACCESSORIES: dangling earrings red #FF0000 with gold #FFD700 stem cherry-shaped, ring gold #FFD700 metal

SCENE: Vintage-style living room at Daytime, late afternoon, Indoor, calm. Key element: Deep teal #008080 velvet sofa with rolled arms, serving as the central anchor of the scene.

BACKGROUND: Textured beige #D2B48C wallpaper, Two wall sconces with frosted glass globes and brass #B5A642 fixtures, Two wooden side tables with turned legs, Two table lamps with pleated white #FFFFFF shades (one with white #FFFFFF ceramic base, one with teal #008080 ceramic base), Sheer white #FFFFFF curtains over a window, Various decorative items on side tables: clear glass decanters, small figurines, Brown #A52A2A patterned throw pillow on sofa, Dark brown #654321 wooden coffee table with turned legs, Floral arrangement (roses, carnations) in pink #E84887, white #FFFFFF, and red #FF0000 hues on coffee table, Stack of books with brown #A52A2A, green #008000, and red #FF0000 spines on coffee table, Carpeted floor in a muted beige #D2B48C tone

LIGHTING: soft, ambient, mixed artificial and natural, diffused from multiple sources (lamps, sconces, window), warm, gentle, slightly hazy

TECHNICAL: Hasselblad H6D-100c, 80mm f/2.8, f/3.5, ISO 320

COMPOSITION: Medium shot, subject centered and occupying the mid-ground, Eye-level, focus on The woman's face and upper body

STYLE: photography, vintage, retro, editorial, cinematic, Wes Anderson-esque, nostalgic, elegant, candid, Dominant muted earth tones (beige #D2B48C, brown #A52A2A, olive green #808000, mustard yellow #FFDB58) contrasted with pops of deep teal #008080 and red #FF0000.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Young East Asian woman with black hair and red cherry earrings., Reclining pose on a deep teal #008080 velvet sofa., Olive green #808000 satin shirt and mustard yellow #FFDB58 velvet skirt., Vintage-style living room with textured beige #D2B48C wallpaper and wall sconces., Wooden coffee table with drinks, books, and a floral arrangement.
CONSTRAINTS - Avoid: Modern furniture or decor., Bright, harsh studio lighting., Overly vibrant or saturated colors., Smiling or overly expressive subject., Any elements that break the vintage aesthetic.`
  },
  {
    id: 7,
    title: "Surreal Dessert",
    category: "food",
    image: "/gallery/7.png",
    prompt: `This still life photograph presents a surreal and elegantly whimsical scene, bathed in soft, high-key lighting. A vibrant, dome-shaped strawberry jelly dessert, featuring a striking purple betta fish encased within, sits centrally on a white cake stand. The delicate composition is enhanced by scattered elements like fresh pink roses, white lilies, weathered driftwood, and reflective broken mirror shards, all arranged on a textured peach-colored surface, creating a dreamlike and slightly unsettling aesthetic.

SUBJECT: A clear, dome-shaped strawberry jelly dessert, vibrant orange-pink #F7B89F, containing several whole, bright red #E02B2B strawberries and a striking purple betta fish. It is topped with a soft dollop of white #FFFFFF whipped cream and a single fresh, whole red #E02B2B strawberry with a small green stem.. Pose: The betta fish is positioned horizontally within the jelly, facing left, with its flowing, iridescent purple #8B5FBB fins elegantly spread.

SCENE: A minimalist studio setting with a textured, solid peach-colored #F7B89F background surface. at Daytime, Not applicable. Key element: A vibrant purple #8B5FBB betta fish, with large, flowing fins, encased perfectly within the translucent strawberry jelly.

BACKGROUND: Several pieces of weathered, light brown #8B6F5B driftwood, varying in size and shape, scattered around the main subject., Multiple irregularly shaped, broken mirror shards, reflecting the peach background and elements, positioned around the scene., Two bouquets of fresh flowers: one cluster of light pink #F7D4D4 roses with green #4A6B3A leaves, and another cluster of white #FFFFFF lilies with green #4A6B3A stems and leaves., Several small, glossy puddles of orange-pink #F7B89F liquid, resembling spilled jelly, on the peach surface.

LIGHTING: Softbox studio lighting, Overhead, slightly angled from the top-right, Soft, even, creating subtle, elongated shadows

TECHNICAL: Sony Alpha A7R IV, Sony FE 90mm f/2.8 Macro G OSS, f/4.0, ISO 160

COMPOSITION: Medium shot, eye-level, Slightly elevated, straight-on perspective, focus on The central strawberry jelly dessert and the betta fish within it

STYLE: photography, Surreal still life, Whimsical, Elegant, Delicate, High-key lighting, Product photography, Dominant peach #F7B89F and light pink #F7D4D4, accented with vibrant red #E02B2B, crisp white #FFFFFF, lush green #4A6B3A, and striking iridescent purple #8B5FBB.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Central dome-shaped strawberry jelly dessert with embedded purple betta fish, White ceramic cake stand, Textured peach-colored #F7B89F background surface, Scattered light pink #F7D4D4 roses and white #FFFFFF lilies, Multiple pieces of weathered driftwood, Broken, reflective mirror shards, Small puddles of spilled orange-pink #F7B89F liquid on the surface
CONSTRAINTS - Avoid: Any human presence or hands, Dark or gloomy lighting conditions, Aggressive or chaotic elements, Realistic aquatic environment for the fish (e.g., water, fish tank), Any text or branding`
  },
  {
    id: 8,
    title: "Love Typography",
    category: "design",
    image: "/gallery/8.png",
    prompt: `This is a vibrant 3D render featuring the word "Love" crafted from a glossy, translucent emerald green material. The letters possess a fluid, bubbly texture, appearing as if made of thick, viscous liquid or gel suspended with numerous tiny air bubbles. Set against a stark, pure black background, the object is illuminated by soft, studio-like lighting that creates prominent specular highlights and reflections, emphasizing its smooth, rounded contours and the depth of its internal bubbles. The overall mood is clean, modern, and playfully elegant.

SUBJECT: The word 'Love' rendered in a stylized, rounded, and fluid typography. Each letter is composed of a translucent, emerald green material, resembling a thick liquid or gel. The material is filled with numerous small, clear air bubbles of varying sizes, giving it a bubbly texture. The surface is highly glossy and reflective.

SCENE: Isolated studio setting at Not applicable (studio lighting), Not applicable. Key element: The word 'Love' itself, with its unique bubbly, translucent green texture and glossy finish.

LIGHTING: Studio lighting, Soft, diffused light from above and slightly front, creating strong specular highlights on the upper surfaces of the letters., Soft, even, with high contrast between the illuminated object and the dark background.

TECHNICAL: 3D Rendering Software, Digital Prime Lens, f/8, ISO 100

COMPOSITION: Medium shot, centered horizontally with ample negative space above and below., Eye-level, slightly elevated to showcase the top surfaces and reflections., focus on The entire word 'Love'

STYLE: 3d_render, glossy, liquid_typography, bubbly, translucent, minimalist, clean_render, modern_design, Dominant vibrant emerald green #00C853 to lighter mint green #80FFB3, with bright white #FFFFFF specular highlights and a pure black #000000 background.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: The word 'Love' spelled out in lowercase., Translucent emerald green #00C853 material for the letters., Bubbly texture with internal air bubbles within the letters., Highly glossy and reflective surface on the letters., Pure black #000000 background., Rounded, fluid, and soft-edged letterforms.
CONSTRAINTS - Avoid: Any background elements or textures other than pure black., Matte, opaque, or metallic textures for the letters., Different colors for the letters or background., Sharp, angular, or rigid letterforms.`
  },
  {
    id: 9,
    title: "Jewel Strawberry",
    category: "branded",
    image: "/gallery/9.png",
    prompt: `This image presents a dazzling, hyperrealistic product photograph or 3D render of an opulent, jewel-encrusted strawberry. The central subject, adorned with brilliant diamonds and vibrant rubies set in rich gold, appears to explode outwards, scattering a magnificent array of multi-colored gemstones and shimmering gold dust against a stark black background. The overall mood is one of extreme luxury and magical extravagance, with sharp focus and dramatic lighting emphasizing the intense sparkle and prismatic refractions of each precious stone, creating a truly captivating visual spectacle.

SUBJECT: A highly detailed, jewel-encrusted strawberry, appearing to burst or explode. The main body of the strawberry is densely covered with numerous round and fancy-cut brilliant white diamonds #FFFFFF, interspersed with oval and round deep ruby red #E0115F gemstones, all meticulously set in polished gold #FFD700 bezels. The top 'calyx' structure is crafted from textured gold #FFD700, also encrusted with smaller brilliant white diamonds #FFFFFF, and features a subtle red #E0115F band at its base.

SCENE: Abstract, pure black #000000 void at Timeless. Key element: The central jewel-encrusted strawberry, acting as the origin point for the explosion of gems and glitter.

BACKGROUND: Numerous scattered, multi-faceted gemstones (brilliant white diamonds #FFFFFF, deep ruby red #E0115F, vibrant emerald green #00C957, deep sapphire blue #0F52BA) appearing to fly outwards, Fine gold #FFD700 glitter and dust particles, also radiating outwards, Rainbow-colored lens flares and prismatic light streaks

LIGHTING: Dramatic studio lighting, Multi-directional, emphasizing facets and sparkle, Hard, brilliant, with intense specular highlights and starburst effects

TECHNICAL: High-end professional camera (e.g., Canon EOS R5), Macro lens (e.g., Canon RF 100mm f/2.8L Macro IS USM), f/11, ISO 100

COMPOSITION: Medium shot, centered on the strawberry, with surrounding elements radiating outwards, Eye-level, slightly elevated perspective, focus on The main body of the jewel-encrusted strawberry

STYLE: High-resolution product photography / 3D render, Luxury, Opulent, Sparkling, High-jewelry, Explosive, Magical realism, Hyperrealistic, Dominant colors include brilliant white #FFFFFF, deep ruby red #E0115F, rich gold #FFD700, vibrant emerald green #00C957, deep sapphire blue #0F52BA, all against a pure black #000000 background.

ASPECT RATIO: 1:1

CONSTRAINTS - Must keep: Jewel-encrusted strawberry as the central subject, Gold calyx with diamond accents, Strawberry body covered in white diamonds and red rubies, Scattering of various colored gemstones (emeralds, sapphires, diamonds, rubies) in motion, Explosion of fine gold glitter/dust particles, Pure black background, Rainbow lens flares/prismatic light effects
CONSTRAINTS - Avoid: Natural strawberry elements (e.g., green leaves, actual seeds), Any background elements other than black and the scattered gems/glitter, Soft or diffused lighting, Muted or desaturated colors, Any text, branding, or logos`
  }
];

const GALLERY_DATA = galleryData;
