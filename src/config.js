const path = require('path');
const fs = require('fs');

const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

// Use the official logo if someone drops it into public/img, otherwise the bundled placeholder.
const logoCandidates = ['jec-logo.png', 'jec-logo.jpg', 'jec-logo.webp', 'jec-logo.svg'];
const logoFile = logoCandidates.find((f) => fs.existsSync(path.join(ROOT, 'public', 'img', f)));

const config = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  DB_FILE: path.join(DATA_DIR, 'lostfound.db'),
  PORT: int(process.env.PORT, 3000),
  IS_PROD: process.env.NODE_ENV === 'production',
  // Set when running behind Nginx / a PaaS load balancer so secure cookies and IPs work.
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  BASE_URL: (process.env.BASE_URL || '').replace(/\/$/, ''),

  LOST_EXPIRY_DAYS: int(process.env.LOST_EXPIRY_DAYS, 15),
  FOUND_EXPIRY_DAYS: int(process.env.FOUND_EXPIRY_DAYS, 30),
  REMINDER_DAYS_BEFORE: int(process.env.REMINDER_DAYS_BEFORE, 2),
  MAX_EXTENSIONS: int(process.env.MAX_EXTENSIONS, 2),
  MAX_PHOTOS: 4,
  MAX_PHOTO_MB: 8,
  MAX_POSTS_PER_DAY: int(process.env.MAX_POSTS_PER_DAY, 10),

  ADMIN_PHONE: process.env.ADMIN_PHONE || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ADMIN_NAME: process.env.ADMIN_NAME || 'Mechatronics Admin',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@jecjabalpur.ac.in',

  site: {
    name: 'JEC Lost & Found',
    college: 'Jabalpur Engineering College',
    collegeShort: 'JEC Jabalpur',
    address: 'Gokalpur, Jabalpur, Madhya Pradesh 482011',
    poweredBy: 'Department of Mechatronics Engineering',
    logo: logoFile ? `/img/${logoFile}` : '/img/logo.svg',
  },

  // name (stored in DB) -> short label, Lucide icon, colour
  categoryList: [
    { name: 'ID Card / Documents', short: 'ID & Documents', icon: 'id-card', color: '#2563eb' },
    { name: 'Mobile Phone', short: 'Phone', icon: 'smartphone', color: '#7c3aed' },
    { name: 'Wallet / Purse', short: 'Wallet', icon: 'wallet', color: '#c2410c' },
    { name: 'Keys', short: 'Keys', icon: 'key-round', color: '#ca8a04' },
    { name: 'Bag / Backpack', short: 'Bag', icon: 'backpack', color: '#0d9488' },
    { name: 'Books / Notes', short: 'Books & Notes', icon: 'book-open', color: '#db2777' },
    { name: 'Calculator', short: 'Calculator', icon: 'calculator', color: '#4f46e5' },
    { name: 'Laptop / Tablet', short: 'Laptop', icon: 'laptop', color: '#0284c7' },
    { name: 'Earphones / Charger', short: 'Earphones', icon: 'headphones', color: '#9333ea' },
    { name: 'Water Bottle / Tiffin', short: 'Bottle & Tiffin', icon: 'glass-water', color: '#0891b2' },
    { name: 'Clothing / Jacket', short: 'Clothing', icon: 'shirt', color: '#ea580c' },
    { name: 'Watch / Jewellery', short: 'Watch & Jewellery', icon: 'watch', color: '#a16207' },
    { name: 'Spectacles', short: 'Spectacles', icon: 'glasses', color: '#475569' },
    { name: 'Lab Equipment / Tools', short: 'Tools', icon: 'wrench', color: '#65a30d' },
    { name: 'Other', short: 'Other', icon: 'shapes', color: '#64748b' },
  ],

  departments: [
    'Mechatronics Engineering',
    'Mechanical Engineering',
    'Civil Engineering',
    'Electrical Engineering',
    'Electronics & Telecommunication',
    'Computer Science & Engineering',
    'Information Technology',
    'Industrial & Production Engineering',
    'Artificial Intelligence & Data Science',
    'Internet of Things',
    'Architecture',
    'MCA',
    'Applied Sciences',
    'Administration / Office',
    'Other',
  ],

  // Suggestions in the "where" field; people can still type anything.
  places: [
    'Central Library',
    'Canteen',
    'Main Building',
    'Mechatronics Department',
    'Workshop',
    'Computer Centre',
    'Auditorium',
    'Sports Ground',
    'Boys Hostel',
    'Girls Hostel',
    'Parking Area',
    'Main Gate',
    'Bus Stop',
    'Classroom',
    'Laboratory',
  ],

  defaultCollectionPoints: [
    'Mechatronics Department Office',
    'Student Section (Main Building)',
    'Central Library Counter',
    'Main Gate Security Desk',
  ],
};

config.categories = config.categoryList.map((c) => c.name);
const byName = Object.fromEntries(config.categoryList.map((c) => [c.name, c]));
config.categoryMeta = (name) => byName[name] || byName.Other;

module.exports = config;
