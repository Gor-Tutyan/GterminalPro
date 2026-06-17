const bcrypt = require('bcryptjs');

(async () => {
    const hash = await bcrypt.hash('admin123', 12);
    console.log(hash);
})();