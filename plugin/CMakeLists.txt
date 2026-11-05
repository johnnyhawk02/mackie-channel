# VLZ Channel Drive: the circuit model in ../mackie-channel-core.js as a VST3.
#
#   cmake -S plugin -B plugin/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build plugin/build --target VlzChannelDrive_VST3 -j8
#
# JUCE is read from ~/Developer/Plugins/JUCE (JUCE 8.0.10); pass -DJUCE_DIR=... for another copy.
cmake_minimum_required(VERSION 3.22)

project(VlzChannelDrive VERSION 1.0.0)

set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "")
set(CMAKE_CXX_STANDARD 17)

set(JUCE_DIR "$ENV{HOME}/Developer/Plugins/JUCE" CACHE PATH "JUCE source folder")
add_subdirectory(${JUCE_DIR} juce)

# The circuit core rounds like JS only without fused multiply-adds
# (JsMath.cpp sets its own contraction with a pragma).
add_library(MackieCore STATIC Source/MackieChannelCore.cpp Source/JsMath.cpp)
target_compile_options(MackieCore PRIVATE -O3 -ffp-contract=off -fno-fast-math)
target_include_directories(MackieCore PUBLIC Source)

juce_add_plugin(VlzChannelDrive
    VERSION 1.0.0
    COMPANY_NAME "Johnny"
    BUNDLE_ID "com.johnny.vlzchanneldrive"
    PLUGIN_MANUFACTURER_CODE Jhny
    PLUGIN_CODE Vlzd
    PRODUCT_NAME "VLZ Channel Drive"
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/../icons/icon-1024.png"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD TRUE
    VST3_COPY_DIR "$ENV{HOME}/Library/Audio/Plug-Ins/VST3/Johnny"
    VST3_CATEGORIES Fx Distortion
    FORMATS VST3 Standalone)

target_sources(VlzChannelDrive PRIVATE Source/PluginProcessor.cpp Source/PluginEditor.cpp)

target_compile_definitions(VlzChannelDrive PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(VlzChannelDrive
    PRIVATE
        MackieCore
        juce::juce_audio_utils
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Null-test tools (tools/README.md): the core on its own, and a host that runs the installed VST3.
add_executable(corerender tools/corerender.cpp)
target_link_libraries(corerender PRIVATE MackieCore)

juce_add_console_app(vst3null PRODUCT_NAME "vst3null")
target_sources(vst3null PRIVATE tools/vst3null.cpp)
target_compile_definitions(vst3null PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_PLUGINHOST_VST3=1)
target_link_libraries(vst3null PRIVATE juce::juce_audio_processors juce::juce_recommended_config_flags)

# Renders the editor to a PNG without a host: snapshot out.png
juce_add_console_app(snapshot PRODUCT_NAME "snapshot")
target_sources(snapshot PRIVATE tools/snapshot.cpp Source/PluginProcessor.cpp Source/PluginEditor.cpp)
target_compile_definitions(snapshot PRIVATE JucePlugin_Name="VLZ Channel Drive" JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
target_link_libraries(snapshot PRIVATE MackieCore juce::juce_audio_utils juce::juce_recommended_config_flags)
