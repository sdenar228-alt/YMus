import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property string text: ""
    property color accent: "#a8a8a8"

    Layout.preferredHeight: 28
    Layout.preferredWidth: label.implicitWidth + 24
    radius: 8
    color: "#14161616"
    border.color: "#283a3a3a"
    border.width: 1

    Text {
        id: label
        anchors.centerIn: parent
        text: root.text
        color: root.accent
        font.pixelSize: 12
    }
}
