#!/usr/bin/env python3
import socket
import ftplib
import os
import shutil
import threading
import time
import re
import datetime
import json
import csv
import argparse
import yaml

PORT_TCP = 9993
BUFFER_SIZE = 4096

# Global runtime configuration dictionary
CONFIG = {}

def load_config_with_overrides():
    """Parses CLI arguments, loads the YAML file, and applies runtime overrides."""
    parser = argparse.ArgumentParser(
        description="HyperDeck Automated Media Ingest Service Daemon",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Example Usage:
  ./hyperdeck_sync.py --config my_event.yaml
  ./hyperdeck_sync.py --destinations /tmp/ingest --drift 60
  ./hyperdeck_sync.py --template "{deck_name}_Slot{slot_id}_{hour}{minute}{ext}"
        """
    )
    
    parser.add_argument("-c", "--config", default="config.yaml", help="Path to YAML configuration file (default: config.yaml)")
    parser.add_argument("-d", "--destinations", nargs="+", help="Override destination folders (space-separated paths)")
    parser.add_argument("-s", "--schedule-file", help="Override schedule mapping file (supports path to .json or .csv)")
    parser.add_argument("--drift", type=int, help="Override maximum schedule matching drift window in minutes")
    parser.add_argument("-t", "--template", help="Override output filename format template")

    args = parser.parse_args()

    # 1. Load configuration from YAML file if available
    file_config = {}
    if os.path.exists(args.config):
        try:
            with open(args.config, 'r', encoding='utf-8') as f:
                file_config = yaml.safe_load(f) or {}
        except Exception as e:
            print(f"❌ Error reading config file '{args.config}': {e}")
            exit(1)
    else:
        # If the user specified a custom config file that doesn't exist, terminate
        if args.config != "config.yaml":
            print(f"❌ Specified config file not found: {args.config}")
            exit(1)
        print("⚠️ 'config.yaml' not found. Relying strictly on CLI arguments or script fallbacks.")

    # 2. Merge values (CLI arguments override YAML config file keys)
    runtime_config = {
        "hyperdecks": file_config.get("hyperdecks", {}),
        "destinations": args.destinations if args.destinations is not None else file_config.get("destinations", []),
        "schedule_file": args.schedule_file if args.schedule_file is not None else file_config.get("schedule_file", "schedule.json"),
        "schedule_max_drift_minutes": args.drift if args.drift is not None else file_config.get("schedule_max_drift_minutes", 45),
        "filename_template": args.template if args.template is not None else file_config.get("filename_template", "{year}-{month}-{day}/{planned_title}_{deck_name}_Slot{slot_id}{ext}")
    }

    # 3. Sanity check parameters before runtime initialization
    if not runtime_config["hyperdecks"]:
        print("❌ Error: No HyperDecks defined in configuration file or arguments.")
        exit(1)
    if not runtime_config["destinations"]:
        print("❌ Error: No download destinations provided.")
        exit(1)

    return runtime_config

def load_raw_schedule():
    """Sniffs the file extension of the configured schedule file and parses it appropriately."""
    sched_path = CONFIG["schedule_file"]
    if not os.path.exists(sched_path):
        print(f"⚠️ Schedule file '{sched_path}' not found.")
        return None

    events = []
    ext = os.path.splitext(sched_path)[1].lower()

    try:
        if ext == '.json':
            with open(sched_path, mode='r', encoding='utf-8') as f:
                events = json.load(f)
        elif ext == '.csv':
            with open(sched_path, mode='r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    clean_row = {k.strip(): v.strip() for k, v in row.items() if k and v}
                    if 'start_time' in clean_row and 'title' in clean_row:
                        events.append({
                            "start_time": clean_row["start_time"],
                            "title": clean_row["title"],
                            "original_name": clean_row.get("original_name", clean_row["title"])
                        })
        else:
            print(f"❌ Unsupported schedule file extension: '{ext}'. Use .json or .csv")
            return None
    except Exception as e:
        print(f"❌ Error parsing schedule file ({sched_path}): {e}")
        return None

    return events

def lookup_scheduled_event(actual_time):
    """Queries the auto-detected schedule array and finds the closest time match."""
    fallback_res = ("Unscheduled_Event", "Unscheduled Event")
    events = load_raw_schedule()

    if events is None:
        return ("Schedule_Missing_Or_Error", "Schedule Missing Or Error")
    if not events:
        return fallback_res

    closest_event = None
    min_delta = datetime.timedelta(minutes=CONFIG["schedule_max_drift_minutes"])

    for item in events:
        if 'start_time' not in item or 'title' not in item:
            continue
        
        time_str = item['start_time'].strip()
        planned_time = None
        
        for time_format in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
            try:
                planned_time = datetime.datetime.strptime(time_str, time_format)
                break
            except ValueError:
                continue
        
        if not planned_time:
            continue
        
        delta = abs(planned_time - actual_time)
        if delta < min_delta:
            min_delta = delta
            closest_event = item

    if closest_event:
        title = closest_event['title'].strip()
        orig_name = closest_event.get('original_name', title).strip()
        return (title, orig_name)
    
    print(f"⚠️ No scheduled event matched within {CONFIG['schedule_max_drift_minutes']} minutes of {actual_time.strftime('%H:%M:%S')}")
    return fallback_res

def get_latest_file_from_ftp(ip, slot_id):
    """Connects to the deck's anonymous FTP server to find the newest clip."""
    try:
        ftp = ftplib.FTP(ip, timeout=10)
        ftp.login()
        ftp.cwd(str(slot_id))
        
        file_list = ftp.nlst()
        video_files = [f for f in file_list if f.lower().endswith(('.mov', '.mp4', '.mxf'))]
        
        ftp.quit()
        if video_files:
            video_files.sort()
            return video_files[-1]
    except Exception as e:
        print(f"[{ip}] Error fetching FTP file list: {e}")
    return None

def download_file_from_ftp(ip, slot_id, remote_filename, local_filename, local_destinations):
    """Downloads file to the first destination, then duplicates it locally."""
    if not local_destinations:
        print(f"[{ip}] Error: No destinations configured.")
        return

    primary_dest = local_destinations[0]
    primary_filepath = os.path.join(primary_dest, local_filename)
    os.makedirs(os.path.dirname(primary_filepath), exist_ok=True)

    try:
        ftp = ftplib.FTP(ip, timeout=30)
        ftp.login()
        ftp.cwd(str(slot_id))
        
        if os.path.exists(primary_filepath):
            try:
                remote_size = ftp.size(remote_filename)
                local_size = os.path.getsize(primary_filepath)
                if local_size == remote_size:
                    print(f"[{ip}] File '{local_filename}' already downloaded. Skipping.")
                    ftp.quit()
                    return
            except Exception:
                pass

        print(f"[{ip}] 📥 Downloading '{remote_filename}' -> '{local_filename}'...")
        with open(primary_filepath, 'wb') as f:
            ftp.retrbinary(f"RETR {remote_filename}", f.write)
        ftp.quit()
        print(f"[{ip}] ✅ Finished downloading primary file.")
        
        for secondary_dest in local_destinations[1:]:
            secondary_filepath = os.path.join(secondary_dest, local_filename)
            os.makedirs(os.path.dirname(secondary_filepath), exist_ok=True)
            
            print(f"[{ip}] 📁 Duplicating locally to: {secondary_filepath}...")
            shutil.copy2(primary_filepath, secondary_filepath)
            print(f"[{ip}] ✅ Duplication complete.")
            
    except Exception as e:
        print(f"[{ip}] ❌ FTP/Copy Error occurred: {e}")

def trigger_file_transfer(name, ip, slot_id, actual_start_time):
    """Runs the schedule lookups, resolves tokens, and hands off execution."""
    time.sleep(2)  
    
    print(f"[{ip}] Querying active slot storage...")
    latest_file = get_latest_file_from_ftp(ip, slot_id)
    
    if latest_file:
        now = datetime.datetime.now()
        original_base, ext = os.path.splitext(latest_file)
        
        planned_title, planned_orig = lookup_scheduled_event(actual_start_time)
        print(f"[{ip}] Match Result: Ingesting recording target mapped to '{planned_title}'")
        
        template_vars = {
            "deck_name": name,
            "slot_id": slot_id,
            "original_name": latest_file,
            "original_base": original_base,
            "ext": ext,
            "planned_title": planned_title,
            "planned_original_name": planned_orig,
            "year": now.strftime("%Y"),
            "month": now.strftime("%m"),
            "day": now.strftime("%d"),
            "hour": now.strftime("%H"),
            "minute": now.strftime("%M"),
            "second": now.strftime("%S"),
        }
        
        try:
            local_filename = CONFIG["filename_template"].format(**template_vars)
        except KeyError as e:
            print(f"[{ip}] ❌ Template config error! Unknown token: {e}. Falling back to original name.")
            local_filename = latest_file
            
        download_file_from_ftp(ip, slot_id, latest_file, local_filename, list(CONFIG["destinations"]))
    else:
        print(f"[{ip}] ⚠️ No valid video files discovered in slot {slot_id}.")

def monitor_hyperdeck(name, ip):
    """Manages the network socket connection and state engine for a single deck."""
    print(f"[{name}] Monitoring worker initialization for {ip}...")
    
    while True:
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(15)
            s.connect((ip, PORT_TCP))
            s.settimeout(None)
            
            print(f"[{name}] Connected to protocol socket successfully.")
            s.recv(BUFFER_SIZE)
            
            s.sendall(b"notify: transport: true\r\n")
            s.recv(BUFFER_SIZE)
            
            network_buffer = ""
            was_recording = False
            actual_start_time = None
            
            while True:
                data = s.recv(BUFFER_SIZE)
                if not data:
                    print(f"[{name}] Remote server terminated connection.")
                    break
                
                network_buffer += data.decode('utf-8', errors='ignore')
                network_buffer = network_buffer.replace("\r\n", "\n")
                
                while "\n\n" in network_buffer:
                    current_msg_block, network_buffer = network_buffer.split("\n\n", 1)
                    
                    if "508 transport info:" in current_msg_block:
                        status_pattern = re.search(r"status:\s*(\w+)", current_msg_block)
                        slot_pattern = re.search(r"slot id:\s*(\d+)", current_msg_block)
                        
                        if status_pattern:
                            current_status = status_pattern.group(1).lower()
                            slot_id = slot_pattern.group(1) if slot_pattern else "1"
                            
                            if current_status == "record":
                                if not was_recording:
                                    actual_start_time = datetime.datetime.now()
                                    print(f"[{name}] 🔴 Recording initiated on Slot {slot_id} at {actual_start_time.strftime('%H:%M:%S')}.")
                                was_recording = True
                                
                            elif current_status in ["stopped", "preview"]:
                                if was_recording:
                                    print(f"[{name}] ⏹️ Recording stopped on Slot {slot_id}!")
                                    was_recording = False
                                    
                                    if not actual_start_time:
                                        actual_start_time = datetime.datetime.now()
                                    
                                    worker = threading.Thread(
                                        target=trigger_file_transfer, 
                                        args=(name, ip, slot_id, actual_start_time),
                                        daemon=True
                                    )
                                    worker.start()
                                    actual_start_time = None
                                    
        except (socket.error, socket.timeout) as e:
            print(f"[{name}] Communication failure: {e}. Re-establishing link in 10 seconds...")
            time.sleep(10)
        except Exception as e:
            print(f"[{name}] Unexpected script exception: {e}. Re-establishing link in 10 seconds...")
            time.sleep(10)
        finally:
            if s:
                s.close()

def main():
    global CONFIG
    CONFIG = load_config_with_overrides()

    print("=== HyperDeck Automated Media Ingest Service ===")
    print(f"Active Destinations: {CONFIG['destinations']}")
    print(f"Fuzzy Matching File: {CONFIG['schedule_file']} (Drift: {CONFIG['schedule_max_drift_minutes']}m)")
    print(f"Naming Template:     {CONFIG['filename_template']}\n")
    
    for name, ip in CONFIG["hyperdecks"].items():
        t = threading.Thread(target=monitor_hyperdeck, args=(name, ip), name=name)
        t.daemon = True
        t.start()
        
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping ingestion services cleanly. Goodbye!")

if __name__ == "__main__":
    main()