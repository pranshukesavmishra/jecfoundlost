const path = require('path');
const fs = require('fs');

const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

// Use the official logo if someone drops it into public/img, otherwise the bundled placeholder.
const logoCandidates = ['jec-logo.png', 'jec-logo.jpg', 'jec-logo.webp', 'jec-logo.svg'];
const logoFile = logoCandidates.find((f) => fs.existsSync(path.join(ROOT, 'public', 'img', f)));

module.exports = {
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

  categories: [
    'ID Card / Documents',
    'Mobile Phone',
    'Wallet / Purse',
    'Keys',
    'Bag / Backpack',
    'Books / Notes',
    'Calculator',
    'Laptop / Tablet',
    'Earphones / Charger',
    'Water Bottle / Tiffin',
    'Clothing / Jacket',
    'Watch / Jewellery',
    'Spectacles',
    'Lab Equipment / Tools',
    'Other',
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
