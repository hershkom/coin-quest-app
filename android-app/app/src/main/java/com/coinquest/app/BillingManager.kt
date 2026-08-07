package com.coinquest.app

import android.app.Activity
import android.util.Base64
import android.util.Log
import com.android.billingclient.api.*
import org.json.JSONObject
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Google Play Billing, with NO server behind it (see MONETIZATION-PLAN.md M2).
 *
 * The entitlement this produces has to be honoured on devices signed in with a
 * DIFFERENT Google account than the buyer's -- in this app the parent buys and
 * the child's own account must benefit. Play alone cannot do that: purchases
 * belong to the purchasing account, so queryPurchases on the child's device
 * returns nothing.
 *
 * So the purchase is shared through the family's own synced record, and every
 * device re-verifies Google's RSA signature over the purchase payload locally
 * before honouring it. Forging an entitlement therefore needs Google's private
 * key rather than just a text editor.
 *
 * What this deliberately does NOT defend against, and can't without a server:
 * someone patching the APK, or editing local storage directly. That's an
 * accepted trade for staying on Firebase's free tier -- see the plan's honest
 * comparison table.
 */
class BillingManager(private val activity: Activity, private val onEvent: (String, String) -> Unit) {

    companion object {
        private const val TAG = "BillingManager"
        const val SKU_MONTHLY = "premium_monthly"
        const val SKU_LIFETIME = "premium_lifetime"

        /**
         * Base64 RSA public key from Play Console → Monetization setup →
         * Licensing. MUST be filled in before release (M0.4).
         *
         * Left empty on purpose rather than with a fake: with no key we report
         * billing as unavailable, so the app quietly behaves as if purchases
         * can't happen. A placeholder that merely *looked* valid would instead
         * make every signature check fail at runtime, which reads to a paying
         * customer as "I bought it and it didn't work".
         */
        const val PLAY_PUBLIC_KEY = ""
    }

    private var billingClient: BillingClient? = null
    private var connected = false
    /** productId -> formatted localised price, e.g. "₪19.90". */
    private val prices = mutableMapOf<String, String>()
    private val productDetails = mutableMapOf<String, ProductDetails>()

    fun start() {
        if (PLAY_PUBLIC_KEY.isBlank()) {
            Log.w(TAG, "No PLAY_PUBLIC_KEY configured -- billing stays unavailable")
            return
        }
        val client = BillingClient.newBuilder(activity)
            .setListener { result, purchases ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK && purchases != null) {
                    purchases.forEach { handlePurchase(it) }
                } else if (result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED) {
                    onEvent("failed", "cancelled")
                } else {
                    onEvent("failed", "code ${result.responseCode}")
                }
            }
            // Required from Billing 8; enables the current purchase flows.
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
        billingClient = client
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                connected = result.responseCode == BillingClient.BillingResponseCode.OK
                if (connected) {
                    queryProducts()
                    // Restore on every launch: a reinstall or a new device has
                    // no local record, and the user must not have to re-buy.
                    restorePurchases()
                }
            }
            override fun onBillingServiceDisconnected() { connected = false }
        })
    }

    fun isAvailable(): Boolean = connected && PLAY_PUBLIC_KEY.isNotBlank()

    /** JSON map of productId -> localised price string, for the paywall. */
    fun productsJson(): String {
        val o = JSONObject()
        prices.forEach { (k, v) -> o.put(k, v) }
        return o.toString()
    }

    private fun queryProducts() {
        val client = billingClient ?: return
        // Subscriptions and one-time products are separate query types.
        val subs = listOf(
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(SKU_MONTHLY).setProductType(BillingClient.ProductType.SUBS).build()
        )
        val inapp = listOf(
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(SKU_LIFETIME).setProductType(BillingClient.ProductType.INAPP).build()
        )
        listOf(subs, inapp).forEach { list ->
            client.queryProductDetailsAsync(
                QueryProductDetailsParams.newBuilder().setProductList(list).build()
            ) { result, queryResult ->
                // Billing 8 hands back a QueryProductDetailsResult wrapper --
                // v7 passed the List<ProductDetails> directly.
                if (result.responseCode != BillingClient.BillingResponseCode.OK) return@queryProductDetailsAsync
                queryResult.productDetailsList.forEach { pd ->
                    productDetails[pd.productId] = pd
                    val price = pd.oneTimePurchaseOfferDetails?.formattedPrice
                        ?: pd.subscriptionOfferDetails?.firstOrNull()
                            ?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice
                    if (price != null) prices[pd.productId] = price
                }
            }
        }
    }

    fun launchPurchase(productId: String) {
        val client = billingClient ?: return
        val pd = productDetails[productId] ?: run { onEvent("failed", "product unavailable"); return }
        val paramsBuilder = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd)
        // A subscription needs the specific offer token; a one-time product must NOT have one.
        pd.subscriptionOfferDetails?.firstOrNull()?.offerToken?.let { paramsBuilder.setOfferToken(it) }
        client.launchBillingFlow(
            activity,
            BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(paramsBuilder.build())).build()
        )
    }

    fun restorePurchases() {
        val client = billingClient ?: return
        listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP).forEach { type ->
            client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(type).build()
            ) { result, purchases ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    purchases.forEach { handlePurchase(it) }
                }
            }
        }
    }

    private fun handlePurchase(p: Purchase) {
        if (p.purchaseState != Purchase.PurchaseState.PURCHASED) return
        if (!verifySignature(p.originalJson, p.signature)) {
            Log.w(TAG, "Purchase signature failed verification -- ignoring")
            onEvent("failed", "signature")
            return
        }
        // Acknowledging is mandatory within 3 days or Play auto-refunds the
        // user. Do it before telling the web layer, so a crash in between
        // can't leave a paid-for-but-refunded purchase.
        if (!p.isAcknowledged) {
            billingClient?.acknowledgePurchase(
                AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.purchaseToken).build()
            ) { /* a failure here is retried by the next restorePurchases() */ }
        }
        val productId = p.products.firstOrNull() ?: return
        val payload = JSONObject()
            .put("productId", productId)
            .put("originalJson", p.originalJson)
            .put("signature", p.signature)
        onEvent("verified", payload.toString())
    }

    /** Google's RSA-SHA1 signature over the purchase JSON, checked offline. */
    private fun verifySignature(data: String, signature: String): Boolean {
        if (PLAY_PUBLIC_KEY.isBlank()) return false
        return try {
            val keyBytes = Base64.decode(PLAY_PUBLIC_KEY, Base64.DEFAULT)
            val key: PublicKey = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(keyBytes))
            val sig = Signature.getInstance("SHA1withRSA")
            sig.initVerify(key)
            sig.update(data.toByteArray())
            sig.verify(Base64.decode(signature, Base64.DEFAULT))
        } catch (e: Exception) {
            Log.e(TAG, "signature verification error", e)
            false
        }
    }

    /** Exposed so the web layer can re-verify an entitlement that arrived via
     *  family sync from a different device / Google account. */
    fun verifyExternal(json: String, signature: String): Boolean = verifySignature(json, signature)

    fun end() { billingClient?.endConnection(); billingClient = null; connected = false }
}
