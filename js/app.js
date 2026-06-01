// ===== Main Store Logic =====
import { db } from './firebase-config.js';
import {
  collection, getDocs, query, orderBy, where
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ===== Cart helpers (shared via localStorage) =====
export function getCart() {
  try { return JSON.parse(localStorage.getItem('cart') || '[]'); }
  catch { return []; }
}
export function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
}
export function addToCart(product) {
  const cart = getCart();
  const existing = cart.find(i => i.id === product.id);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, product.stock ?? 99);
  } else {
    cart.push({ id: product.id, name: product.name, price: product.price, image: product.image || '', quantity: 1, stock: product.stock ?? 99 });
  }
  saveCart(cart);
  updateCartCount();
}
export function updateCartCount() {
  const total = getCart().reduce((s, i) => s + i.quantity, 0);
  document.querySelectorAll('#cartCount').forEach(el => { el.textContent = total; });
}

// ===== Toast =====
let toastTimer;
export function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ===== Sanitize text (prevent XSS when inserting into DOM) =====
function safe(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str ?? ''));
  return d.innerHTML;
}

// ===== Build a product card DOM element =====
function buildProductCard(product) {
  const inStock = (product.stock ?? 1) > 0;

  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.id = product.id;

  // Image
  if (product.image) {
    const img = document.createElement('img');
    img.className = 'product-image';
    img.alt = product.name ?? '';
    img.loading = 'lazy';
    img.src = product.image;
    img.onerror = () => { img.replaceWith(buildPlaceholder()); };
    card.appendChild(img);
  } else {
    card.appendChild(buildPlaceholder());
  }

  // Body
  const body = document.createElement('div');
  body.className = 'product-body';

  if (product.category) {
    const cat = document.createElement('p');
    cat.className = 'product-category';
    cat.textContent = product.category;
    body.appendChild(cat);
  }

  const name = document.createElement('h3');
  name.className = 'product-name';
  name.textContent = product.name ?? '';
  body.appendChild(name);

  if (product.description) {
    const desc = document.createElement('p');
    desc.className = 'product-desc';
    desc.textContent = product.description;
    body.appendChild(desc);
  }

  const footer = document.createElement('div');
  footer.className = 'product-footer';

  const price = document.createElement('span');
  price.className = 'product-price';
  price.textContent = `₪${Number(product.price ?? 0).toFixed(2)}`;
  footer.appendChild(price);

  if (!inStock) {
    const out = document.createElement('span');
    out.className = 'product-stock-out';
    out.textContent = 'אזל המלאי';
    footer.appendChild(out);
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = '🛒 הוסף לעגלה';
    btn.addEventListener('click', () => {
      addToCart(product);
      showToast(`${product.name} נוסף לעגלה ✓`, 'success');
    });
    footer.appendChild(btn);
  }

  body.appendChild(footer);
  card.appendChild(body);
  return card;
}

function buildPlaceholder() {
  const div = document.createElement('div');
  div.className = 'product-image-placeholder';
  div.textContent = '🛍️';
  return div;
}

// ===== Load & render products =====
let allProducts = [];

async function loadProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;

  // Show spinner
  grid.innerHTML = '<div class="loading"><div class="spinner"></div><br>טוען מוצרים...</div>';

  try {
    const q = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    allProducts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderProducts(allProducts);
    populateCategories(allProducts);
  } catch (err) {
    console.error('Error loading products:', err);
    grid.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h3>שגיאה בטעינת המוצרים</h3><p>נסה לרענן את הדף</p></div>';
  }
}

function renderProducts(products) {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!products.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="icon">🔍</div><h3>לא נמצאו מוצרים</h3><p>נסה לחפש משהו אחר</p>';
    grid.appendChild(empty);
    return;
  }

  products.forEach(p => grid.appendChild(buildProductCard(p)));
}

function populateCategories(products) {
  const sel = document.getElementById('categoryFilter');
  if (!sel) return;
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}

// ===== Search & Filter =====
function filterProducts() {
  const search = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
  const category = document.getElementById('categoryFilter')?.value || '';

  const filtered = allProducts.filter(p => {
    const matchSearch = !search || (p.name ?? '').toLowerCase().includes(search) || (p.description ?? '').toLowerCase().includes(search);
    const matchCat = !category || p.category === category;
    return matchSearch && matchCat;
  });
  renderProducts(filtered);
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
  loadProducts();

  document.getElementById('searchInput')?.addEventListener('input', filterProducts);
  document.getElementById('categoryFilter')?.addEventListener('change', filterProducts);

  // Mobile menu toggle
  document.querySelector('.hamburger')?.addEventListener('click', () => {
    document.querySelector('.nav-links')?.classList.toggle('open');
  });
});
