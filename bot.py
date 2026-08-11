import os
import discord
from discord.ext import commands
from discord import app_commands
from dotenv import load_dotenv

import database
from parsers.boxoffice import BoxOfficeParser
from parsers.atlantic import AtlanticCrosswordParser
from parsers.timeline import TimelineParser
from parsers.cluesbysam import CluesBySamParser

load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')

# Initialize parsers
parsers = [
    BoxOfficeParser(),
    AtlanticCrosswordParser(),
    TimelineParser(),
    CluesBySamParser()
]

# Map channel names to game names
CHANNEL_GAME_MAP = {
    "timeline": "Timeline",
    "clues-by-sam": "Clues By Sam",
    "crossword": "Atlantic Daily Crossword",
    "box-office-game": "Box Office Game"
}

# Set up bot
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix='!', intents=intents)

@bot.event
async def on_ready():
    await database.init_db()
    try:
        synced = await bot.tree.sync()
        print(f"Synced {len(synced)} command(s)")
    except Exception as e:
        print(e)
    print(f'Logged in as {bot.user.name} ({bot.user.id})')

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
        
    text = message.content
    if not text:
        return
        
    for parser in parsers:
        if parser.can_parse(text):
            result = parser.parse(text, message.created_at)
            if result:
                puzzle_id, score = result
                await database.record_score(
                    str(message.author.id),
                    message.author.display_name,
                    parser.game_name,
                    puzzle_id,
                    score
                )
                
                # Format score display
                score_display = f"{score:.0f}" if score.is_integer() else f"{score:.2f}"
                if parser.ascending: # Typically time-based
                    if score > 60:
                        mins = int(score // 60)
                        secs = int(score % 60)
                        score_display = f"{mins}m {secs}s"
                    else:
                        score_display = f"{score:.0f}s"
                
                try:
                    await message.edit(suppress=True)
                except discord.Forbidden:
                    pass
                
                await message.add_reaction("✅")
                
                # Fetch daily leaderboard and reply
                daily_ranks = await database.get_puzzle_leaderboard(parser.game_name, puzzle_id, parser.ascending)
                if daily_ranks:
                    embed = discord.Embed(title=f"Daily Rank: {parser.game_name} ({puzzle_id})", color=discord.Color.green())
                    
                    # Track rank with ties
                    current_rank = 1
                    current_score = daily_ranks[0]['score']
                    
                    desc = ""
                    for i, row in enumerate(daily_ranks):
                        if row['score'] != current_score:
                            current_rank = i + 1
                            current_score = row['score']
                            
                        medal = "🥇" if current_rank == 1 else "🥈" if current_rank == 2 else "🥉" if current_rank == 3 else f"#{current_rank}"
                        
                        display_val = f"{row['score']:.0f}" if row['score'].is_integer() else f"{row['score']:.2f}"
                        if parser.ascending:
                            if row['score'] > 60:
                                mins = int(row['score'] // 60)
                                secs = int(row['score'] % 60)
                                display_val = f"{mins}m {secs}s"
                            else:
                                display_val = f"{row['score']:.0f}s"
                                
                        user_str = f"**{row['username']}**" if row['user_id'] == str(message.author.id) else row['username']
                        desc += f"{medal} {user_str} : {display_val}\n"
                        
                    embed.description = desc
                    await message.reply(embed=embed)
                break
                
    await bot.process_commands(message)

async def build_leaderboard_embed(parser):
    if parser.bucket_by_day:
        bucketed_rows = await database.get_bucketed_leaderboard(parser.game_name, parser.ascending)
        medals_data = await database.get_bucketed_medal_counts(parser.game_name, parser.ascending)
        
        days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        has_any = False
        embed = discord.Embed(title=f"Leaderboard: {parser.game_name}", color=discord.Color.gold())
        
        for day in days:
            rows = bucketed_rows.get(day, [])
            if not rows: continue
            has_any = True
            
            day_text = ""
            for i, row in enumerate(rows):
                username = row['username']
                plays = row['plays']
                avg_score = row['avg_score']
                
                day_medals = medals_data.get(username, {}).get(day, {'1st': 0, '2nd': 0, '3rd': 0})
                day_medal_str = f"🥇{day_medals['1st']} 🥈{day_medals['2nd']} 🥉{day_medals['3rd']}"
                
                score_display = f"{avg_score:.1f}"
                if parser.ascending:
                    if avg_score > 60:
                        score_display = f"{int(avg_score // 60)}m {int(avg_score % 60)}s"
                    else:
                        score_display = f"{avg_score:.0f}s"
                        
                rank = "🏆" if i == 0 else f"#{i+1}"
                day_text += f"{rank} **{username}** • {day_medal_str}\nAvg: {score_display} ({plays} plays)\n\n"
                
            embed.add_field(name=f"📅 {day}", value=day_text, inline=False)
            
        if has_any:
            global_rows = await database.get_leaderboard(parser.game_name, parser.ascending)
            if global_rows:
                global_text = ""
                for i, row in enumerate(global_rows):
                    username = row['username']
                    plays = row['plays']
                    avg_score = row['avg_score']
                    
                    global_medals = medals_data.get(username, {}).get('global', {'1st': 0, '2nd': 0, '3rd': 0})
                    glob_medal_str = f"🥇{global_medals['1st']} 🥈{global_medals['2nd']} 🥉{global_medals['3rd']}"
                    
                    score_display = f"{avg_score:.1f}"
                    if parser.ascending:
                        if avg_score > 60:
                            score_display = f"{int(avg_score // 60)}m {int(avg_score % 60)}s"
                        else:
                            score_display = f"{avg_score:.0f}s"
                            
                    rank = "🏆" if i == 0 else f"#{i+1}"
                    global_text += f"{rank} **{username}** • {glob_medal_str}\nAvg: {score_display} ({plays} plays)\n\n"
                    
                embed.add_field(name="🌍 All Days", value=global_text, inline=False)
            return embed
        return None
    else:
        rows = await database.get_leaderboard(parser.game_name, parser.ascending)
        if not rows: return None
        
        medals_data = await database.get_medal_counts(parser.game_name, parser.ascending)
        embed = discord.Embed(title=f"Leaderboard: {parser.game_name}", color=discord.Color.gold())
        
        for i, row in enumerate(rows):
            username = row['username']
            plays = row['plays']
            avg_score = row['avg_score']
            
            user_medals = medals_data.get(username, {'1st': 0, '2nd': 0, '3rd': 0})
            medal_str = f"🥇{user_medals['1st']} 🥈{user_medals['2nd']} 🥉{user_medals['3rd']}"
            
            score_display = f"{avg_score:.1f}"
            if parser.ascending:
                if avg_score > 60:
                    score_display = f"{int(avg_score // 60)}m {int(avg_score % 60)}s"
                else:
                    score_display = f"{avg_score:.0f}s"
                    
            medal = "🏆" if i == 0 else f"#{i+1}"
            embed.add_field(name=f"{medal} {username} • {medal_str}", value=f"Avg: {score_display} ({plays} plays)", inline=False)
            
        return embed

@bot.tree.command(name="leaderboard", description="Show the leaderboard for a specific game")
@app_commands.describe(game="The name of the game (e.g., 'Box Office Game', 'Timeline')")
async def leaderboard(interaction: discord.Interaction, game: str = None):
    if not game:
        channel_name = interaction.channel.name.lower() if interaction.channel else ""
        if channel_name in CHANNEL_GAME_MAP:
            game = CHANNEL_GAME_MAP[channel_name]
        else:
            await interaction.response.send_message("Please specify a game! Example: `/leaderboard game: Box Office Game`")
            return
            
    # Find the parser to know sorting order
    parser = next((p for p in parsers if p.game_name.lower() == game.lower()), None)
    if not parser:
        supported = ", ".join([p.game_name for p in parsers])
        await interaction.response.send_message(f"Game not found. Supported games: {supported}")
        return
        
    embed = await build_leaderboard_embed(parser)
    if not embed:
        await interaction.response.send_message(f"No scores recorded for {parser.game_name} yet.")
        return
        
    await interaction.response.send_message(embed=embed)

@bot.command(name="leaderboard")
async def leaderboard_cmd(ctx, *, game: str = None):
    if not game:
        channel_name = ctx.channel.name.lower() if ctx.channel else ""
        if channel_name in CHANNEL_GAME_MAP:
            game = CHANNEL_GAME_MAP[channel_name]
        else:
            await ctx.send("Please specify a game! Example: `!leaderboard Box Office Game`")
            return
        
    parser = next((p for p in parsers if p.game_name.lower() == game.lower()), None)
    if not parser:
        supported = ", ".join([p.game_name for p in parsers])
        await ctx.send(f"Game not found. Supported games: {supported}")
        return
        
    embed = await build_leaderboard_embed(parser)
    if not embed:
        await ctx.send(f"No scores recorded for {parser.game_name} yet.")
        return
        
    await ctx.send(embed=embed)

def is_mod(interaction: discord.Interaction) -> bool:
    if interaction.user.guild_permissions.administrator:
        return True
    if hasattr(interaction.user, "roles"):
        return any(role.name.lower() == "mod" for role in interaction.user.roles)
    return False

@bot.tree.command(name="user_scores", description="View a user's recent score history")
@app_commands.describe(user="The user to look up")
async def user_scores(interaction: discord.Interaction, user: discord.Member):
    scores = await database.get_user_scores(str(user.id))
    if not scores:
        await interaction.response.send_message(f"No recent scores found for {user.display_name}.", ephemeral=True)
        return
        
    embed = discord.Embed(title=f"Recent Scores: {user.display_name}", color=discord.Color.blue())
    
    for row in scores:
        game = row['game_name']
        puzzle = row['puzzle_id']
        score = row['score']
        
        score_display = f"{score:.0f}"
        if game in ["Clues By Sam", "Atlantic Daily Crossword"]:
            if score > 60:
                score_display = f"{int(score // 60)}m {int(score % 60)}s"
            else:
                score_display = f"{score:.0f}s"
                
        embed.add_field(name=f"{game}", value=f"Puzzle: `{puzzle}`\\nScore: {score_display}", inline=False)
        
    await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="remove_score", description="Mod: Remove a specific score for a user")
@app_commands.describe(
    user="The user whose score to remove",
    game="The name of the game",
    puzzle_id="The ID of the puzzle (e.g., '193' or '2026-08-08')"
)
async def remove_score(interaction: discord.Interaction, user: discord.Member, game: str, puzzle_id: str):
    if not is_mod(interaction):
        await interaction.response.send_message("You need the 'mod' role or Administrator permissions to use this command.", ephemeral=True)
        return
        
    deleted = await database.delete_score(str(user.id), game, puzzle_id)
    if deleted:
        await interaction.response.send_message(f"✅ Removed {game} score for {user.display_name} on puzzle `{puzzle_id}`.")
    else:
        await interaction.response.send_message(f"❌ Could not find a {game} score for {user.display_name} on puzzle `{puzzle_id}`.", ephemeral=True)

if __name__ == "__main__":
    if TOKEN:
        bot.run(TOKEN)
    else:
        print("Please set DISCORD_TOKEN environment variable.")
