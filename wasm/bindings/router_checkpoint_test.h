// Actual-PNS regression driver. Like the other CollabTest hooks, mutations run on the
// editor's apply coroutine. No mock router, geometry, board or commit implementation.
#pragma once

#include <router/pns_kicad_iface.h>
#include <router/pns_meander_placer_base.h>

static unsigned routerTestSequence = 0;
static bool routerTestOk = false;

static std::string pcbCollabTestRouter( std::string aCommand )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    if( !fr ) return "{}";
    auto* tool = fr->GetToolManager()->GetTool<ROUTER_TOOL>();
    if( !aCommand.empty() )
    {
        json command = json::parse( aCommand );
        pcbjam_collab::runOnCoroutine( fr, [fr, tool, command]()
        {
            const std::string op = command.at( "op" );
            if( op == "start" ) tool->Reset( TOOL_BASE::RESET_REASON::RUN );
            PNS::ROUTER* router = tool->Router();
            routerTestOk = false;
            if( router )
            {
                VECTOR2I p( command.value( "x", 0 ), command.value( "y", 0 ) );
                auto resolve = [&]( const std::string& id ) -> PNS::ITEM*
                {
                    BOARD_ITEM* item = fr->GetBoard()->ResolveItem( KIID( id ), true );
                    return item ? router->GetWorld()->FindItemByParent( item ) : nullptr;
                };
                if( op == "start" )
                {
                    router->Settings().SetMode( PNS::RM_MarkObstacles );
                    PNS::SIZES_SETTINGS sizes = router->Sizes();
                    sizes.SetTrackWidth( 200000 );
                    sizes.SetDiffPairWidth( 200000 );
                    sizes.SetDiffPairGap( 250000 );
                    sizes.SetViaDiameter( 600000 );
                    sizes.SetViaDrill( 300000 );
                    router->UpdateSizes( sizes );
                    router->SetMode( static_cast<PNS::ROUTER_MODE>( command.at( "mode" ).get<int>() ) );
                    std::vector<PNS::ROUTER::BUS_START> lanes;
                    PNS::ITEM_SET items;
                    for( const auto& id : command.at( "ids" ) )
                    {
                        if( PNS::ITEM* item = resolve( id.get<std::string>() ) )
                        {
                            items.Add( item );
                            PNS::ROUTER::BUS_START lane;
                            lane.item = item;
                            lane.net = item->Net();
                            lane.anchor = item->Anchor( item->AnchorCount() - 1 );
                            lane.layer = 0;
                            lanes.push_back( lane );
                        }
                    }
                    router->SetBusStarts( lanes );
                    routerTestOk = command.value( "drag", false )
                            ? router->StartDragging( p, items, PNS::DM_ANY )
                            : router->StartRouting( p, items.Empty() ? nullptr : items[0], 0 );
                }
                else if( op == "move" ) routerTestOk = router->Move( p, nullptr );
                else if( op == "fix" ) routerTestOk = router->FixRoute( p, nullptr, false, false );
                else if( op == "via" ) { router->ToggleViaPlacement(); routerTestOk = true; }
                else if( op == "layer" ) routerTestOk = router->SwitchLayer( command.at( "layer" ) );
                else if( op == "spacing" ) routerTestOk = router->BumpBusSpacing( command.at( "step" ) );
                else if( op == "undo" ) routerTestOk = router->UndoLastSegment().has_value();
                else if( op == "tuning" )
                {
                    if( auto* tuner = dynamic_cast<PNS::MEANDER_PLACER_BASE*>( router->Placer() ) )
                    {
                        PNS::MEANDER_SETTINGS settings = tuner->MeanderSettings();
                        settings.m_spacing = 600000;
                        settings.m_maxAmplitude = 3000000;
                        settings.SetTargetLength( 25000000 );
                        settings.SetTargetSkew( 10000000 );
                        tuner->UpdateSettings( settings );
                        routerTestOk = true;
                    }
                }
                else if( op == "commit" ) { router->CommitRouting(); routerTestOk = true; }
                else if( op == "cancel" ) { router->StopRouting(); routerTestOk = true; }
            }
            ++routerTestSequence;
        } );
    }

    PNS::ROUTER* router = tool->Router();
    json result = { { "sequence", routerTestSequence }, { "ok", routerTestOk },
                    { "active", router && router->RoutingInProgress() },
                    { "checkpoint", router && router->CanCollabCheckpoint() } };
    if( router && router->RoutingInProgress() )
    {
        std::vector<PNS::ITEM*> removed, added, heads;
        router->GetUpdatedItems( removed, added, heads );
        result["added"] = added.size();
        result["removed"] = removed.size();
        result["preview"] = added.size() + heads.size();
        for( PNS::ITEM* item : heads ) delete item;
        if( auto* tuner = dynamic_cast<PNS::MEANDER_PLACER_BASE*>( router->Placer() ) )
            result["spacing"] = tuner->MeanderSettings().m_spacing;
    }
    return result.dump();
}
