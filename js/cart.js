// ===== Cart Page Logic =====
import { getCart, saveCart, updateCartCount, showToast } from './app.js';

// ===== Config — update before going live =====
const TRANZILA_TERMINAL = 'YOUR_TRANZILA_TERMINAL_ID';
const PAYPAL_CLIENT_ID  = 'AUAqNYjs9flt_Vn4MiF-0mJKcmgEQwaJOnB8H6kDTuBHMkOkAVXkPkVarVCxE4b2r6z9QWq_o946ZBZl';  // sandbox or live
const SITE_URL          = window.location.origin;

// ===== Render cart =====
function renderCart() {
  const cart = getCart();
  const tbody = document.getElementById('cartItems');
  const emptyEl = document.getElementById('cartEmpty');
  const tableEl = document.getElementById('cartTable');
  const summaryEl = document.getElementById('cartSummary');
  if (!tbody) return;

  if (!cart.length) {
    if (emptyEl) emptyEl.style.display = 'block';
    if (tableEl) tableEl.style.display = 'none';
    if (summaryEl) summaryEl.style.display = 'none';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (tableEl) tableEl.style.display = 'block';
  if (summaryEl) summaryEl.style.display = 'block';

  tbody.innerHTML = '';
  cart.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'cart-item';

    // Info
    const info = document.createElement('div');
    info.className = 'cart-item-info';
    if (item.image) {
      const img = document.createElement('img');
      img.className = 'cart-item-img';
      img.src = item.image;
      img.alt = item.name;
      img.onerror = () => { img.style.display = 'none'; };
      info.appendChild(img);
    }
    const nameWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'cart-item-name';
    nameEl.textContent = item.name;
    const priceEach = document.createElement('div');
    priceEach.className = 'cart-item-price-each';
    priceEach.textContent = `₪${Number(item.price).toFixed(2)} ליחידה`;
    nameWrap.appendChild(nameEl);
    nameWrap.appendChild(priceEach);
    info.appendChild(nameWrap);
    row.appendChild(info);

    // Quantity
    const qtyWrap = document.createElement('div');
    qtyWrap.className = 'qty-control';

    const minusBtn = document.createElement('button');
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '−';
    minusBtn.setAttribute('aria-label', 'הפחת כמות');
    minusBtn.addEventListener('click', () => changeQty(idx, -1));

    const qtyVal = document.createElement('span');
    qtyVal.className = 'qty-value';
    qtyVal.textContent = item.quantity;

    const plusBtn = document.createElement('button');
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'הגדל כמות');
    plusBtn.addEventListener('click', () => changeQty(idx, 1));

    qtyWrap.appendChild(minusBtn);
    qtyWrap.appendChild(qtyVal);
    qtyWrap.appendChild(plusBtn);
    row.appendChild(qtyWrap);

    // Item total
    const total = document.createElement('div');
    total.className = 'cart-item-total';
    total.textContent = `₪${(item.price * item.quantity).toFixed(2)}`;
    row.appendChild(total);

    // Remove
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'הסר פריט');
    removeBtn.addEventListener('click', () => removeItem(idx));
    row.appendChild(removeBtn);

    tbody.appendChild(row);
  });

  updateSummary(cart);
}

function changeQty(idx, delta) {
  const cart = getCart();
  if (!cart[idx]) return;
  cart[idx].quantity = Math.max(1, Math.min(cart[idx].quantity + delta, cart[idx].stock ?? 99));
  saveCart(cart);
  updateCartCount();
  renderCart();
}

function removeItem(idx) {
  const cart = getCart();
  cart.splice(idx, 1);
  saveCart(cart);
  updateCartCount();
  renderCart();
  showToast('פריט הוסר מהעגלה');
}

function updateSummary(cart) {
  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const shipping = subtotal > 0 ? 30 : 0;   // flat ₪30 shipping
  const total = subtotal + shipping;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subtotal', `₪${subtotal.toFixed(2)}`);
  set('shipping', shipping === 0 ? 'חינם' : `₪${shipping.toFixed(2)}`);
  set('totalAmount', `₪${total.toFixed(2)}`);

  return total;
}

// ===== Validate customer form =====
function getCustomerInfo() {
  const name  = document.getElementById('custName')?.value.trim();
  const email = document.getElementById('custEmail')?.value.trim();
  const phone = document.getElementById('custPhone')?.value.trim();

  if (!name || !email || !phone) {
    showToast('נא למלא את כל פרטי הלקוח לפני התשלום', 'error');
    return null;
  }
  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('כתובת האימייל אינה תקינה', 'error');
    return null;
  }
  return { name, email, phone };
}

// ===== Tranzila checkout =====
function checkoutWithTranzila() {
  const customer = getCustomerInfo();
  if (!customer) return;

  const cart = getCart();
  if (!cart.length) { showToast('העגלה שלך ריקה', 'error'); return; }

  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const total = subtotal + 30; // + shipping

  // Build order description
  const desc = cart.map(i => `${i.name} x${i.quantity}`).join(', ');

  const params = new URLSearchParams({
    supplier:    TRANZILA_TERMINAL,
    sum:         total.toFixed(2),
    currency:    '1',             // 1 = ILS
    contact:     customer.name,
    email:       customer.email,
    phone:       customer.phone,
    pdesc:       desc.substring(0, 250),
    success_url: `${SITE_URL}/success.html`,
    fail_url:    `${SITE_URL}/fail.html`,
    nologo:      '1',
    lang:        'heb',
  });

  // Redirect to Tranzila hosted payment page (card data never touches our site)
  window.location.href = `https://secure5.tranzila.com/cgi-bin/tranzila71u.cgi?${params.toString()}`;
}

// ===== PayPal smart buttons =====
function initPayPal() {
  const container = document.getElementById('paypal-button-container');
  if (!container) return;
  if (typeof paypal === 'undefined') {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">לא ניתן לטעון את כפתור PayPal. בדוק את חיבור האינטרנט.</p>';
    return;
  }

  paypal.Buttons({
    style: { layout: 'vertical', color: 'blue', shape: 'rect', label: 'pay' },

    createOrder: (data, actions) => {
      const customer = getCustomerInfo();
      if (!customer) return actions.reject();

      const cart = getCart();
      if (!cart.length) { showToast('העגלה שלך ריקה', 'error'); return actions.reject(); }

      const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
      const shipping = 30;
      const total = (subtotal + shipping).toFixed(2);

      return actions.order.create({
        purchase_units: [{
          description: 'הזמנה מהחנות שלי',
          amount: {
            currency_code: 'ILS',
            value: total,
            breakdown: {
              item_total:  { currency_code: 'ILS', value: subtotal.toFixed(2) },
              shipping:    { currency_code: 'ILS', value: shipping.toFixed(2) },
            }
          },
          items: cart.map(i => ({
            name: i.name,
            quantity: String(i.quantity),
            unit_amount: { currency_code: 'ILS', value: Number(i.price).toFixed(2) },
          }))
        }]
      });
    },

    onApprove: (data, actions) => {
      return actions.order.capture().then(details => {
        saveCart([]);
        updateCartCount();
        window.location.href = `success.html?method=paypal&name=${encodeURIComponent(details.payer.name.given_name)}`;
      });
    },

    onError: (err) => {
      console.error('PayPal error:', err);
      showToast('אירעה שגיאה עם PayPal. נסה שוב.', 'error');
    }
  }).render('#paypal-button-container');
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
  renderCart();

  document.getElementById('tranzilaBtn')?.addEventListener('click', checkoutWithTranzila);

  // Load PayPal SDK dynamically (only if cart has items)
  const cart = getCart();
  if (cart.length && PAYPAL_CLIENT_ID !== 'YOUR_PAYPAL_CLIENT_ID') {
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(PAYPAL_CLIENT_ID)}&currency=ILS`;
    script.onload = initPayPal;
    document.head.appendChild(script);
  } else if (cart.length) {
    // Show placeholder if PayPal not yet configured
    const el = document.getElementById('paypal-button-container');
    if (el) el.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem;text-align:center">PayPal לא הוגדר עדיין</p>';
  }

  // Mobile menu
  document.querySelector('.hamburger')?.addEventListener('click', () => {
    document.querySelector('.nav-links')?.classList.toggle('open');
  });
});
