/*
 * Live color-theme switch (comments-ux 0002 F4): kicadSetColorTheme(name)
 * re-points the frame's app settings `color_theme` and drives the frame's own
 * CommonSettingsChanged — the exact path the desktop Preferences dialog uses
 * to hot-apply a theme (SCH_BASE_FRAME / PCB_BASE_FRAME reload COLOR_SETTINGS
 * into the painter, recache the view, refresh). SETTINGS_MANAGER resolves
 * colors/<name>.json from the MEMFS config dir on demand, so the JSON only
 * has to exist (standalone boot seeding writes it — web/standalone
 * src/wasm/boot.ts). The changed app settings are saved back to MEMFS so a
 * same-session relaunch (warm pool) comes up already themed.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <eda_draw_frame.h>
#include <nlohmann/json.hpp>
#include <pgm_base.h>
#include <settings/app_settings.h>
#include <settings/settings_manager.h>
#include <string>
#include <cmath>
#include <regex>
#include <wx/event.h>
#include <wx/menu.h>
#include <wx/window.h>

#include "collab_common.h"

// wx wasm port chrome appearance (wxwidgets src/wasm/settings.cpp): the
// system-colour table every widget paints from.
extern "C" void wxWasmSetDarkAppearance( bool dark );
extern "C" bool wxWasmGetDarkAppearance();
extern "C" void wxWasmSetChromeTheme( const int* colors, const char* font, int pixelSize,
                                       bool dark );

namespace pcbjam_theme {

/** Merged-image hook (installed by kicad_editor_embind.cpp): re-assert the
 *  canvas-only chrome state after a theme apply. CommonSettingsChanged
 *  recreates the menubar (CallAfter-deferred, eda_base_frame.cpp) and the
 *  toolbars, and they come back SHOWN — without this, a theme apply
 *  resurrects the chrome kicadSetChrome(false) hid (read-only viewer /
 *  mobile canvas-only). Inline variable: the dispatcher TU re-declares the
 *  identical definition instead of including this (deliberately
 *  header-light) — keep the two in sync. Null in the standalone bundles,
 *  which have no chrome API. */
inline void ( *g_afterThemeApplied )() = nullptr;

/** Set the chrome appearance FLAG only — no widget traffic, no coroutine. Safe
 *  from the browser main thread at any point (it writes one bool in shared
 *  wasm memory); the embedder calls it at onRuntimeInitialized, BEFORE main()
 *  spawns on the KiCad pthread, so the first widget paint is already themed.
 *  (Module.ENV proved unreliable for this: the pthread builds its environ
 *  from its own worker's ENV, not the main runtime's.) */
inline void setDarkChromeFlag( bool aDark )
{
    wxWasmSetDarkAppearance( aDark );
}

/** Flip the wx CHROME (panels/toolbars/dialogs — the system-colour table) and
 *  broadcast the change so every live window repaints:
 *  wxWindowBase::OnSysColourChanged recurses to children, and
 *  EDA_BASE_FRAME's handler additionally re-themes icons and rebuilds
 *  toolbars/menubar. No-op when the appearance didn't change (the merged
 *  image calls the theme entry once per editor). No DOM probing here — this
 *  runs on the KiCad pthread, which has no `document`. */
inline void syncChromeAppearance( bool aDark )
{
    if( aDark == wxWasmGetDarkAppearance() )
        return;

    wxWasmSetDarkAppearance( aDark );

    for( wxWindowList::const_iterator it = wxTopLevelWindows.begin();
         it != wxTopLevelWindows.end(); ++it )
    {
        wxWindow* tlw = *it;
        wxSysColourChangedEvent evt;
        evt.SetEventObject( tlw );
        tlw->GetEventHandler()->ProcessEvent( evt );
        tlw->Refresh();
    }
}

/** Validate and synchronously install the complete native chrome palette and
 * default font. This is deliberately free of wxWindow/DOM traffic, so it is
 * safe from onRuntimeInitialized before main constructs any widgets. */
inline bool setChromeThemeFlag( const std::string& aJson )
{
    static const char* keys[] = { "paper", "surface", "hover", "line", "ink", "muted",
                                  "accent", "accentInk" };
    static const std::regex colorPattern( "^#[0-9a-fA-F]{6}$" );

    try
    {
        const nlohmann::json value = nlohmann::json::parse( aJson );
        if( !value.is_object() || value.size() != 11 || !value.at( "font" ).is_string()
            || value.at( "font" ).get<std::string>().empty()
            || !value.at( "pixelSize" ).is_number() || !value.at( "dark" ).is_boolean() )
            return false;

        const double pixelSize = value.at( "pixelSize" ).get<double>();
        if( !std::isfinite( pixelSize ) || pixelSize < 1.0 || pixelSize > 256.0 )
            return false;

        int colors[24];
        for( size_t i = 0; i < 8; ++i )
        {
            const auto& field = value.at( keys[i] );
            if( !field.is_string() || !std::regex_match( field.get_ref<const std::string&>(),
                                                         colorPattern ) )
                return false;

            const std::string& color = field.get_ref<const std::string&>();
            for( size_t channel = 0; channel < 3; ++channel )
                colors[i * 3 + channel] = std::stoi( color.substr( 1 + channel * 2, 2 ),
                                                      nullptr, 16 );
        }

        const std::string font = value.at( "font" ).get<std::string>();
        wxWasmSetChromeTheme( colors, font.c_str(), static_cast<int>( std::lround( pixelSize ) ),
                              value.at( "dark" ).get<bool>() );
        return true;
    }
    catch( const std::exception& )
    {
        return false;
    }
}

// wx's default event propagation excludes top-level children (dialogs), and
// wxWasm Refresh invalidates only this window's canvas. Cover both explicitly.
inline void refreshChromeWindows( wxWindow* aWindow )
{
    if( aWindow->IsTopLevel() )
    {
        wxSysColourChangedEvent evt;
        evt.SetEventObject( aWindow );
        aWindow->GetEventHandler()->ProcessEvent( evt );
    }

    for( wxWindow* child : aWindow->GetChildren() )
        refreshChromeWindows( child );

    aWindow->Refresh();
}

/** Widget-only work belongs on wx's event loop, not the board apply queue:
 * a toolbar action holds that queue for the entire lifetime of its dialog.
 * wx's dispatch interlock handles JSPI suspensions in these event handlers. */
inline void refreshChromeTheme( EDA_DRAW_FRAME* aFrame )
{
    if( !aFrame )
        return;

    aFrame->CallAfter( [aFrame]() {
        const bool menuHidden = aFrame->GetMenuBar() && !aFrame->GetMenuBar()->IsShown();
        refreshChromeWindows( aFrame );
        // System-colour handlers recreate menus; keep Registry's native bar hidden
        // even while a modal dialog disables the toolbar's usual update pass.
        if( menuHidden && aFrame->GetMenuBar() )
        {
            aFrame->GetMenuBar()->Hide();
            aFrame->SendSizeEvent();
        }
    } );
}

/** Apply `aTheme` ("pcbjam-dark", "_builtin_default", …) to one frame. Runs
 *  on the apply coroutine: CommonSettingsChanged reaches tool/view internals
 *  that must not run from a bare JS callback. Null frame no-ops (the merged
 *  dispatcher calls every editor, open or not). */
inline void setColorTheme( EDA_DRAW_FRAME* aFrame, const std::string& aTheme )
{
    if( !aFrame )
        return;

    pcbjam_collab::runOnCoroutine( aFrame, [aFrame, aTheme]() {
        // The shell only ever sends our dark theme name or the builtin
        // default, so the chrome appearance rides on that distinction.
        const bool         dark = aTheme != "_builtin_default";
        const wxString     theme = wxString::FromUTF8( aTheme.c_str() );
        APP_SETTINGS_BASE* cfg = aFrame->config();

        // The shell re-sends its theme on EVERY boot (a warm relaunch can
        // have stale MEMFS settings from a HomePage theme switch) — skip the
        // apply when nothing changes: CommonSettingsChanged below is not
        // free, it rebuilds the menubar and toolbars.
        if( cfg && cfg->m_ColorTheme == theme && dark == wxWasmGetDarkAppearance() )
            return;

        if( cfg )
        {
            cfg->m_ColorTheme = theme;
            // Persist now — wasm sessions never exit cleanly, so the normal
            // save-on-close path would lose the choice.
            Pgm().GetSettingsManager().Save( cfg );
        }

        // wx chrome first (panels/toolbars), then the GAL canvas colors.
        syncChromeAppearance( dark );

        // 0 flags: no env/text vars changed; the frame's override chain still
        // unconditionally reloads colors and recaches the view.
        aFrame->CommonSettingsChanged( 0 );

        // Queued from INSIDE the coroutine body, AFTER CommonSettingsChanged: the
        // menubar rebuild it triggers is itself a CallAfter on this same
        // handler, so FIFO puts the re-assert behind the rebuilt (shown)
        // menubar.
        if( void ( *hook )() = g_afterThemeApplied )
            aFrame->CallAfter( hook );
    } );
}

} // namespace pcbjam_theme

#endif // __EMSCRIPTEN__
