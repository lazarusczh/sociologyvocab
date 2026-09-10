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
        applyEdgeToEdge(true);
    }

    @Override
    public void onPostCreate(Bundle savedInstanceState) {
        super.onPostCreate(savedInstanceState);
        // Capacitor 在 onCreate 里才完成 setContentView，这里再确认一次，
        // 避免布局/insets 应用后又把内容推回系统栏内侧。
        applyEdgeToEdge(true);
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台返回时保持同一策略；图标明暗不在这里改（子站会用插件临时切成浅色图标）
        applyEdgeToEdge(false);
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
}
