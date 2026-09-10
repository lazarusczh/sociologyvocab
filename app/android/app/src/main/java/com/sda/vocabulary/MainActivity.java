package com.sda.vocabulary;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyEdgeToEdge(true);
        setupInsetsListener();
        applyTopInset();

        // 主站 ↔ 知识库子站是整页跳转：页面可见后按新 URL 重新计算顶部避让
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                applyTopInset();
            }
        });
    }

    @Override
    public void onPostCreate(Bundle savedInstanceState) {
        super.onPostCreate(savedInstanceState);
        // Capacitor 在 onCreate 里才完成 setContentView，这里再确认一次
        applyEdgeToEdge(true);
        setupInsetsListener();
        applyTopInset();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台返回时保持策略；图标明暗不在这里改（子站会临时切成浅色图标）
        applyEdgeToEdge(false);
        applyTopInset();
    }

    /**
     * 彻底 edge-to-edge：内容延伸到状态栏与导航栏下方，两处系统栏都由页面内容自绘。
     * 底部一律不处理 —— 内容铺到屏幕底边，手势条悬浮在内容之上。
     */
    private void applyEdgeToEdge(boolean syncIconAppearance) {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 关掉系统给透明系统栏加的对比度遮罩（否则会在系统栏上盖半透明灰）
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }
        if (syncIconAppearance) {
            boolean dark = (getResources().getConfiguration().uiMode
                    & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
        }
    }

    /**
     * insets 变化时按当前页面重新决定顶部避让：
     *   主站  → 父容器顶部 padding = 状态栏高度（顶栏保持原高，状态栏区域由 windowBackground 填 surface 色）
     *   子站  → 顶部 0（深蓝顶栏自绘铺满状态栏）
     * 不消费 insets，继续向下分发（WebView 侧仍可用 env(safe-area-inset-*)）。
     */
    private void setupInsetsListener() {
        WebView webView = getBridge().getWebView();
        if (webView == null || !(webView.getParent() instanceof View)) {
            return;
        }
        final View host = (View) webView.getParent();
        webView.setPadding(0, 0, 0, 0);
        ViewCompat.setOnApplyWindowInsetsListener(host, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int top = isSkillSite() ? 0 : bars.top;
            v.setPadding(0, top, 0, 0);
            Log.i(TAG, "insets applied: top=" + top + " url=" + currentUrl());
            return insets;
        });
    }

    /** 主动读取当前 insets 并应用（双保险：不依赖监听回调一定触发）。 */
    private void applyTopInset() {
        WebView webView = getBridge().getWebView();
        if (webView == null || !(webView.getParent() instanceof View)) {
            return;
        }
        final View host = (View) webView.getParent();
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(host);
        int top = 0;
        if (insets != null && !isSkillSite()) {
            top = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()).top;
        }
        final int topPx = top;
        runOnUiThread(() -> {
            host.setPadding(0, topPx, 0, 0);
            Log.i(TAG, "top inset applied: top=" + topPx + " url=" + currentUrl());
        });
    }

    private String currentUrl() {
        WebView webView = getBridge().getWebView();
        return webView != null ? webView.getUrl() : null;
    }

    private boolean isSkillSite() {
        String url = currentUrl();
        return url != null && url.contains("/skill/");
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyTopInset();
    }
}
