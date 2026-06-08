import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property url iconSource: ""
    property string label: ""
    property bool active: false
    property bool showLabel: true
    property bool lightTheme: backend.settings.theme === "Светлая"
    signal clicked()

    Layout.fillWidth: true
    Layout.preferredHeight: 52
    radius: 8
    color: active ? (lightTheme ? "#fff4c6" : "#2a231000") : (mouse.containsMouse ? (lightTheme ? "#eef0f4" : "#101c1a08") : "transparent")
    border.color: active ? "#66ffd400" : (mouse.containsMouse ? "#20ffd400" : "transparent")
    border.width: 1

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 15
        anchors.rightMargin: 15
        spacing: 12
        Image {
            source: root.iconSource
            sourceSize.width: 20
            sourceSize.height: 20
            Layout.preferredWidth: 22
            Layout.preferredHeight: 22
            smooth: true
            mipmap: true
            fillMode: Image.PreserveAspectFit
            opacity: root.active ? 1 : 0.72
        }
        Text {
            visible: root.showLabel
            text: root.label
            color: root.active ? (root.lightTheme ? "#1a1b1f" : "#ffd400") : (root.lightTheme ? "#5a5c66" : "#cfcfcf")
            font.bold: true
            font.pixelSize: 14
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.clicked()
    }
}
