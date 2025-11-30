package com.diode.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.diode.capacitornode.DiodeNodePlugin;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(DiodeNodePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
