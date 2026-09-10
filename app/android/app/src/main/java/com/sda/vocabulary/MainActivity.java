package com.sda.vocabulary;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyEdgeToEdge(true);

        // 主站与知识库子站之间是整页跳转，这里按 URL 决定「WebView 顶部是否避开状态栏」。
        // 放在原生侧（而不是 JS 调插件）是为了不依赖 bridge/脚本的执行时机。
        //   主站  ：避让 —— 状态栏区域由 windowBackground 填 surface 色，与顶栏同色且顶栏保持原高
        //   子站  ：不避让 —— 顶栏是品牌深蓝，由它自己铺满状态栏区域
        // 底部一律不处理：内容延伸到屏幕底边，手势条悬浮在内容之上。
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                applyTopInsetForUrl(url);
            }
        });
    }

    @Override
    public void onPostCreate(Bundle savedInstanceState) {
        super.onPostCreate(savedInstanceState);
        // Capacitor 在 onCreate 里才完成 setContentView，这里再确认一次
        applyEdgeToEdge(true);
        applyTopInsetForUrl(currentUrl());
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台返回时保持策略；图标明暗不在这里改（子站会临时切成浅色图标）
        applyEdgeToEdge(false);
        applyTopInsetForUrl(currentUrl());
    }

    private String currentUrl() {
        WebView webView = getBridge().getWebView();
        return webView != null ? webView.getUrl() : null;
    }

    /** 彻底 edge-to-edge：内容延伸到状态栏与导航栏下方，两处系统栏都由页面内容自绘。 */
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
     * 主站：顶部留出状态栏高度（顶栏保持原高，状态栏由原生填色）；
     * 知识库子站：顶部 0（顶栏自绘铺满状态栏）；底部一律 0（内容铺到屏幕底边）。
     */
    private void applyTopInsetForUrl(String url) {
        boolean skillSite = url != null && url.contains("/skill/");
        int top = 0;
        if (!skillSite) {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) {
                top = getResources().getDimensionPixelSize(id);
            }
        }
        final int topPx = top;
        runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setPadding(webView.getPaddingLeft(), topPx, webView.getPaddingRight(), 0);
            }
        });
    }
}
