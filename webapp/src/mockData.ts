// Mock data for development/demo without backend

export const mockCategories = [
  { id: "cat-1", name: "Smartfonlar" },
  { id: "cat-2", name: "Noutbuklar" },
  { id: "cat-3", name: "Aksessuarlar" },
  { id: "cat-4", name: "Audio" }
];

export const mockProducts = [
  // Smartphones
  {
    id: "prod-1", categoryId: "cat-1", article: "IP15PM-256",
    name: "iPhone 15 Pro Max 256GB Natural Titanium",
    description: "Apple A17 Pro chip, 48MP main camera, titanium frame, USB-C connector, Action button. 6.7-inch Super Retina XDR display.",
    price: 14990000
  },
  {
    id: "prod-2", categoryId: "cat-1", article: "SGS24",
    name: "Samsung S24",
    description: "Snapdragon 8 Gen 3, 50MP camera, 6.2-inch Dynamic AMOLED 2X display, 4000mAh battery.",
    price: 9800000
  },
  {
    id: "prod-3", categoryId: "cat-1", article: "X14U-512",
    name: "Xiaomi 14 Ultra Global 512GB Ceramic White",
    description: "Leica professional optical system, Snapdragon 8 Gen 3, 90W wired charging, IP68 rating.",
    price: 7500000
  },
  {
    id: "prod-4", categoryId: "cat-1", article: "GP8",
    name: "Pixel 8",
    description: "Google Tensor G3 chip, 7 years of OS updates, Magic Eraser, Call Screen. 6.2-inch OLED display.",
    price: 820000
  },

  // Laptops
  {
    id: "prod-5", categoryId: "cat-2", article: "MBP16-M3-1TB",
    name: "Apple MacBook Pro 16-inch M3 Max 1TB Space Black",
    description: "M3 Max chip with 16-core CPU and 40-core GPU, 48GB unified memory, 22-hour battery life, Liquid Retina XDR display.",
    price: 45000000
  },
  {
    id: "prod-6", categoryId: "cat-2", article: "DXPS15",
    name: "Dell XPS 15",
    description: "Intel Core i7-13700H, 16GB RAM, 512GB SSD, 15.6-inch OLED 3.5K display, NVIDIA GeForce RTX 4060.",
    price: 18500000
  },
  {
    id: "prod-7", categoryId: "cat-2", article: "LTP-X1-11",
    name: "Lenovo ThinkPad X1 Carbon Gen 11 Intel Core i7",
    description: "Ultra-light 1.12kg business laptop. Intel Evo platform, 14-inch IPS display, MIL-SPEC durability tested.",
    price: 16200000
  },
  {
    id: "prod-8", categoryId: "cat-2", article: "ROG-G16",
    name: "ROG Strix G16",
    description: "Intel Core i9-13980HX, NVIDIA RTX 4080, 32GB DDR5, 240Hz QHD display. Built for competitive gaming.",
    price: 22000000
  },

  // Accessories
  {
    id: "prod-9", categoryId: "cat-3", article: "APP2-C",
    name: "AirPods Pro 2nd Generation USB-C",
    description: "Active Noise Cancellation, Adaptive Transparency, Personalized Spatial Audio, USB-C charging case.",
    price: 2800000
  },
  {
    id: "prod-10", categoryId: "cat-3", article: "MK-BLK",
    name: "Keyboard",
    description: "Compact USB membrane keyboard. Full-size layout, quiet keys, plug-and-play.",
    price: 95000
  },
  {
    id: "prod-11", categoryId: "cat-3", article: "USBC-7P",
    name: "USB-C Hub 7-in-1 Multiport Adapter HDMI 4K",
    description: "HDMI 4K@60Hz, 3× USB-A 3.0, SD/microSD card reader, 100W Power Delivery passthrough.",
    price: 450000
  },
  {
    id: "prod-12", categoryId: "cat-3", article: "MX3S",
    name: "MX Master 3S",
    description: "8000 DPI Darkfield sensor, MagSpeed electromagnetic scroll wheel, Bluetooth, up to 70 days battery.",
    price: 1250000
  },
  {
    id: "prod-13", categoryId: "cat-3", article: "PC-BLK",
    name: "Case",
    description: "Slim silicone protective case. Raised edges protect screen and camera. Available in multiple colors.",
    price: 35000
  },

  // Audio
  {
    id: "prod-14", categoryId: "cat-4", article: "SONY-XM5",
    name: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    description: "Industry-leading noise cancellation, 30-hour battery, Speak-to-Chat, multipoint connection, 3.5mm audio jack.",
    price: 4200000
  },
  {
    id: "prod-15", categoryId: "cat-4", article: "BOSE-QC45",
    name: "Bose QC45",
    description: "Quiet Comfort technology, 24-hour battery, lightweight design, Aware Mode, simple Bluetooth pairing.",
    price: 3800000
  },
  {
    id: "prod-16", categoryId: "cat-4", article: "JBL-F6",
    name: "JBL Flip 6",
    description: "IP67 waterproof, 12-hour battery, PartyBoost to connect multiple speakers, JBL Pro Sound.",
    price: 1200000
  },
  {
    id: "prod-17", categoryId: "cat-4", article: "MRSH-EMB2",
    name: "Marshall Emberton II Portable Bluetooth Speaker",
    description: "30-hour battery, IP67 waterproof, True Stereophonic multi-directional sound, USB-C charging.",
    price: 1850000
  }
];

export const getGroupedMockProducts = () => {
  const grouped: Record<string, typeof mockProducts> = {};
  mockProducts.forEach(product => {
    if (!grouped[product.categoryId]) {
      grouped[product.categoryId] = [];
    }
    grouped[product.categoryId].push(product);
  });
  return grouped;
};
