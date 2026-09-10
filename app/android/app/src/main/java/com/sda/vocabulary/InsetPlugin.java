package com.sda.vocabulary;

import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 顶部安全区的开关注入：让 WebView 顶部避开状态栏（主站用）或顶到状态栏（子站用）。
 *
 * 背景：应用整体是 edge-to-edge（内容延伸到状态栏与导航栏下方），底部不消费 inset，
 * 所以页面内容能一直铺到屏幕底边（手势条悬浮在内容之上）。
 * 但顶部两个页面需求相反：
 *   - 主站顶栏是浅色 surface，状态栏区域本来就与它同色 → WebView 应当从状态栏下方开始，
 *     顶栏保持原有高度（状态栏区域由原生 windowBackground 填 surface 色，无缝衔接）；
 *   - 知识库子站顶栏是品牌深蓝，希望状态栏区域由顶栏自己铺色。
 * 于是用本插件按页面切换顶部 padding，底部一律不处理。
 */
@CapacitorPlugin(name = "InsetPlugin")
public class InsetPlugin extends Plugin {

    @PluginMethod
    public void setTopInsetPadding(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", Boolean.TRUE));
        int top = 0;
        if (enabled) {
            int id = getContext().getResources()
                    .getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) {
                top = getContext().getResources().getDimensionPixelSize(id);
            }
        }
        final int topPx = top;
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setPadding(
                        webView.getPaddingLeft(),
                        topPx,
                        webView.getPaddingRight(),
                        webView.getPaddingBottom());
            }
        });
        JSObject ret = new JSObject();
        ret.put("topPx", topPx);
        call.resolve(ret);
    }
}
