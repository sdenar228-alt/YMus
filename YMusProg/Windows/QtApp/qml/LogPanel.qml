import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"

    radius: 10
    color: lightTheme ? "#ffffff" : "#820f0f0f"
    border.color: lightTheme ? "#e2e4ea" : "#22303030"
    border.width: 1

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 0

        Text { text: "Журнал"; color: root.lightTheme ? "#16140b" : "#f5f2e9"; font.pixelSize: 16; font.bold: true }
        Text { text: "Последние действия программы"; color: root.lightTheme ? "#5b563d" : "#a8a8a8"; font.pixelSize: 12 }

        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.topMargin: 12
            clip: true
            model: backend.logs
            delegate: RowLayout {
                width: ListView.view.width
                height: Math.max(20, message.implicitHeight)
                spacing: 8
                Text { text: modelData.time; color: root.lightTheme ? "#5b563d" : "#a8a8a8"; font.pixelSize: 11; Layout.preferredWidth: 50 }
                Text { text: modelData.level; color: "#ffd400"; font.pixelSize: 10; font.bold: true; Layout.preferredWidth: 56 }
                Text {
                    id: message
                    text: modelData.message
                    color: root.lightTheme ? "#5b563d" : "#a8a8a8"
                    font.pixelSize: 11
                    wrapMode: Text.WordWrap
                    Layout.fillWidth: true
                }
            }
        }
    }
}
