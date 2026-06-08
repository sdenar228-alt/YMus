import QtQuick
import QtQuick.Layouts

Rectangle {
    property url source: ""
    property bool lightTheme: backend.settings.theme === "Светлая"
    Layout.preferredWidth: 36
    Layout.preferredHeight: 36
    radius: 8
    color: lightTheme ? "#f4f5f8" : "#131308"
    border.color: lightTheme ? "#e2e4ea" : "#4a4430"
    border.width: 1

    Image {
        anchors.centerIn: parent
        source: parent.source
        sourceSize.width: 20
        sourceSize.height: 20
        width: 20
        height: 20
        smooth: true
        mipmap: true
        fillMode: Image.PreserveAspectFit
    }
}
