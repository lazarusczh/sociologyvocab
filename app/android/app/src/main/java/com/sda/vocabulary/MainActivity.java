package com.sda.vocabulary;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 彻底 edge-to-edge：让 WebView 内容延伸到状态栏与导航栏下方，两处系统栏都由
        // 页面内容自绘（顶栏铺状态栏区、页面底色铺导航栏区）。
        // 若不这样，导航栏虽然设成 transparent，也只能透出 windowBackground 的颜色，
        // 页面底色与它不同就会出现一条色带 —— 这正是之前"导航栏透明没彻底实现"的原因。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 关闭系统给透明系统栏加的对比度遮罩，否则会在系统栏上盖一层半透明灰
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        // 图标明暗跟随系统主题（与 values / values-night 的 windowLight* 保持一致）；
        // 知识库子站顶栏是深蓝，进入子站后由前端用 StatusBar 插件临时改成浅色图标。
        boolean dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }
}
