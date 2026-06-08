import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"
    radius: 10
    color: lightTheme ? "#ffffff" : "#b20f0f0f"
    border.color: lightTheme ? "#e2e4ea" : "#303030"
    border.width: 1

    ScrollView {
        id: settingsInnerScroll
        anchors.fill: parent
        anchors.margins: 14
        clip: true
        contentWidth: availableWidth

        ColumnLayout {
            width: settingsInnerScroll.availableWidth
            spacing: 0

            SettingToggle { iconSource: assetsDir + "/icons/update.svg"; settingKey: "autoUpdate"; label: "Автоматически обновлять расширение"; checked: backend.settings.autoUpdate }
            SettingToggle { iconSource: assetsDir + "/icons/search.svg"; settingKey: "checkOnStart"; label: "Проверять обновления при запуске"; checked: backend.settings.checkOnStart }
            SettingToggle { iconSource: assetsDir + "/icons/power.svg"; settingKey: "runAtStartup"; label: "Запускать YMus вместе с системой"; checked: backend.settings.runAtStartup }
            SettingToggle { iconSource: assetsDir + "/icons/tray.svg"; settingKey: "minimizeToTray"; label: "Сворачивать в трей"; checked: backend.settings.minimizeToTray }
            SettingToggle { iconSource: assetsDir + "/icons/bell.svg"; settingKey: "notifications"; label: "Показывать уведомления об обновлениях"; checked: backend.settings.notifications }
            SettingCombo { iconSource: assetsDir + "/icons/palette.svg"; settingKey: "theme"; label: "Тема интерфейса"; value: backend.settings.theme; options: ["Темная", "Светлая"] }
            SettingCombo { iconSource: assetsDir + "/icons/globe.svg"; settingKey: "language"; label: "Язык интерфейса"; value: backend.settings.language; options: ["Русский"] }

            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 58
                spacing: 10
                SettingIcon { source: assetsDir + "/icons/folder.svg" }
                Text { text: "Папка расширения"; color: root.lightTheme ? "#171717" : "#f5f2e9"; font.pixelSize: 13; Layout.fillWidth: true }
                Rectangle {
                    Layout.preferredWidth: Math.min(250, Math.max(170, root.width * 0.28))
                    Layout.preferredHeight: 34
                    radius: 7
                    color: root.lightTheme ? "#f4f5f8" : "#141414"
                    border.color: root.lightTheme ? "#d3d6de" : "#3b3b2c"
                    Text {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        text: backend.preparedPath
                        color: root.lightTheme ? "#171717" : "#f5f2e9"
                        font.pixelSize: 12
                        elide: Text.ElideMiddle
                        verticalAlignment: Text.AlignVCenter
                    }
                }
                GlassButton { text: "Изменить"; textColor: "#ffd400"; preferredWidth: 94; onClicked: backend.open_prepared_folder() }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 58
                spacing: 10
                SettingIcon { source: assetsDir + "/icons/database.svg" }
                Text { text: "Резервное копирование настроек"; color: root.lightTheme ? "#171717" : "#f5f2e9"; font.pixelSize: 13; Layout.fillWidth: true }
                GlassButton { text: "Создать копию"; textColor: "#ffd400"; preferredWidth: 150; onClicked: backend.create_backup() }
                GlassButton { text: "Сбросить"; preferredWidth: 104; onClicked: backend.reset_settings() }
            }
        }
    }
}
