// ===== Admin Panel Logic =====
import { db, auth } from './firebase-config.js';
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ===== Auth =====
const loginPanel  = document.getElementById('loginPanel');
const adminPanel  = document.getElementById('adminPanel');
const loginError  = document.getElementById('loginError');
const adminEmail  = document.getElementById('adminEmail');
const logoutBtn   = document.getElementById('logoutBtn');
const userDisplay = document.getElementById('userDisplay');

onAuthStateChanged(auth, user => {
  if (user) {
    loginPanel?.classList.add('hidden');
    adminPanel?.classList.remove('hidden');
    if (userDisplay) userDisplay.textContent = user.email;
    loadProducts();
  } else {
    loginPanel?.classList.remove('hidden');
    adminPanel?.classList.add('hidden');
  }
});

document.getElementById('loginForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn      = document.getElementById('loginBtn');

  btn.disabled = true;
  btn.textContent = 'מתחבר...';
  if (loginError) { loginError.className = 'login-error'; loginError.textContent = ''; }

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    let msg = 'שגיאה בהתחברות. בדוק אימייל וסיסמה.';
    if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      msg = 'אימייל או סיסמה שגויים.';
    } else if (err.code === 'auth/too-many-requests') {
      msg = 'יותר מדי ניסיונות. נסה שוב מאוחר יותר.';
    }
    if (loginError) { loginError.textContent = msg; loginError.className = 'login-error show'; }
  } finally {
    btn.disabled = false;
    btn.textContent = 'התחבר';
  }
});

logoutBtn?.addEventListener('click', async () => {
  await signOut(auth);
});

// ===== Products =====
let products = [];
let editingId = null;  // null = new product, string = editing existing

const productList = document.getElementById('productList');
const formTitle   = document.getElementById('formTitle');
const productForm = document.getElementById('productForm');
const cancelEdit  = document.getElementById('cancelEdit');
const imgPreview  = document.getElementById('imgPreview');

async function loadProducts() {
  if (!productList) return;
  productList.innerHTML = '<p style="color:var(--text-muted);padding:.5rem">טוען...</p>';

  try {
    const q = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProductList();
  } catch (err) {
    console.error(err);
    productList.innerHTML = '<p style="color:var(--danger)">שגיאה בטעינת המוצרים</p>';
  }
}

function renderProductList() {
  if (!productList) return;
  productList.innerHTML = '';

  if (!products.length) {
    productList.innerHTML = '<p style="color:var(--text-muted);padding:.5rem;text-align:center">אין מוצרים עדיין</p>';
    return;
  }

  products.forEach(p => {
    const item = document.createElement('div');
    item.className = 'admin-product-item';

    // Thumbnail
    if (p.image) {
      const img = document.createElement('img');
      img.className = 'admin-product-thumb';
      img.src = p.image;
      img.alt = p.name;
      img.onerror = () => { img.style.display = 'none'; };
      item.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'admin-product-thumb';
      ph.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:var(--primary-light)';
      ph.textContent = '🛍️';
      item.appendChild(ph);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'admin-product-info';

    const name = document.createElement('div');
    name.className = 'admin-product-name';
    name.textContent = p.name ?? '';
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'admin-product-meta';

    const stockBadge = document.createElement('span');
    stockBadge.className = `badge ${(p.stock ?? 0) > 0 ? 'badge-in' : 'badge-out'}`;
    stockBadge.textContent = (p.stock ?? 0) > 0 ? `במלאי (${p.stock})` : 'אזל';

    meta.textContent = `₪${Number(p.price ?? 0).toFixed(2)} · `;
    meta.appendChild(stockBadge);
    info.appendChild(meta);

    item.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'admin-product-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = '✏️ עריכה';
    editBtn.addEventListener('click', () => startEdit(p));
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '🗑️';
    delBtn.setAttribute('aria-label', 'מחק מוצר');
    delBtn.addEventListener('click', () => confirmDelete(p.id, p.name));
    actions.appendChild(delBtn);

    item.appendChild(actions);
    productList.appendChild(item);
  });
}

// ===== Form helpers =====
function getField(id) { return document.getElementById(id)?.value.trim() ?? ''; }
function setField(id, val) { const el = document.getElementById(id); if (el) el.value = val ?? ''; }

function resetForm() {
  productForm?.reset();
  editingId = null;
  if (formTitle) formTitle.textContent = 'הוסף מוצר חדש';
  if (cancelEdit) cancelEdit.style.display = 'none';
  if (imgPreview) { imgPreview.style.display = 'none'; imgPreview.src = ''; }
}

function startEdit(p) {
  editingId = p.id;
  if (formTitle) formTitle.textContent = 'ערוך מוצר';
  if (cancelEdit) cancelEdit.style.display = 'inline-flex';

  setField('fieldName',     p.name);
  setField('fieldDesc',     p.description);
  setField('fieldPrice',    p.price);
  setField('fieldStock',    p.stock);
  setField('fieldCategory', p.category);
  setField('fieldImage',    p.image);

  if (imgPreview && p.image) { imgPreview.src = p.image; imgPreview.style.display = 'block'; }

  document.getElementById('productForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Image preview on URL input
document.getElementById('fieldImage')?.addEventListener('input', e => {
  if (!imgPreview) return;
  const url = e.target.value.trim();
  if (url) { imgPreview.src = url; imgPreview.style.display = 'block'; }
  else { imgPreview.style.display = 'none'; imgPreview.src = ''; }
});

cancelEdit?.addEventListener('click', resetForm);

// ===== Save product (add or update) =====
productForm?.addEventListener('submit', async e => {
  e.preventDefault();
  const saveBtn = document.getElementById('saveBtn');

  const name     = getField('fieldName');
  const price    = parseFloat(getField('fieldPrice'));
  const stock    = parseInt(getField('fieldStock'), 10);
  const category = getField('fieldCategory');
  const desc     = getField('fieldDesc');
  const image    = getField('fieldImage');

  // Validation
  if (!name) { showAdminToast('שם המוצר חובה', 'error'); return; }
  if (isNaN(price) || price < 0) { showAdminToast('מחיר לא תקין', 'error'); return; }
  if (isNaN(stock)  || stock  < 0) { showAdminToast('כמות במלאי לא תקינה', 'error'); return; }
  if (image && !isValidUrl(image)) { showAdminToast('כתובת התמונה אינה תקינה', 'error'); return; }

  const data = { name, price, stock, category, description: desc, image, updatedAt: serverTimestamp() };

  saveBtn.disabled = true;
  saveBtn.textContent = 'שומר...';

  try {
    if (editingId) {
      await updateDoc(doc(db, 'products', editingId), data);
      showAdminToast('המוצר עודכן בהצלחה ✓', 'success');
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, 'products'), data);
      showAdminToast('המוצר נוסף בהצלחה ✓', 'success');
    }
    resetForm();
    await loadProducts();
  } catch (err) {
    console.error(err);
    showAdminToast('שגיאה בשמירה. בדוק הרשאות Firestore.', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = editingId ? 'שמור שינויים' : 'הוסף מוצר';
  }
});

// ===== Delete =====
async function confirmDelete(id, name) {
  if (!confirm(`האם אתה בטוח שברצונך למחוק את "${name}"?`)) return;
  try {
    await deleteDoc(doc(db, 'products', id));
    showAdminToast('המוצר נמחק', 'success');
    await loadProducts();
  } catch (err) {
    console.error(err);
    showAdminToast('שגיאה במחיקה', 'error');
  }
}

// ===== Helpers =====
function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

let adminToastTimer;
function showAdminToast(msg, type = '') {
  const el = document.getElementById('adminToast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// Hidden helper for CSS transitions
document.head.insertAdjacentHTML('beforeend', '<style>.hidden{display:none!important}</style>');
