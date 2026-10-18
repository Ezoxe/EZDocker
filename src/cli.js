// Maintenance commands, run inside the container:
//   node src/cli.js reset-admin [new-password]
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { generatePassword } = require('./util');

function resetAdmin(password) {
  db.open(config.dbFile);
  const admin = db.get("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1");
  if (!admin) {
    console.error('Aucun super admin : il sera créé au prochain démarrage.');
    process.exit(1);
  }
  const pwd = password || generatePassword(16);
  auth.validatePassword(pwd);
  db.run('UPDATE users SET password_hash = ?, must_change_password = ?, disabled = 0 WHERE id = ?', auth.hashPassword(pwd), password ? 0 : 1, admin.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', admin.id);
  db.close();
  console.log(`Utilisateur : ${admin.username}`);
  console.log(`Mot de passe : ${pwd}`);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case 'reset-admin':
    resetAdmin(arg);
    process.exit(0);
    break;
  default:
    console.log('Usage : node src/cli.js reset-admin [mot-de-passe]');
    process.exit(command ? 1 : 0);
}
